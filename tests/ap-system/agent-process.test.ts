import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { makeFunctionReference } from "convex/server";
import { convexToJson, jsonToConvex } from "convex/values";
import { fixture, packet, refs } from "./accounting-fixture";

afterEach(() => vi.unstubAllEnvs());
it("runs the actual CLI over HTTP, survives SIGKILL after claim and resumes from retained backend state", async () => {
  const f = await fixture(),
    dir = mkdtempSync(join(tmpdir(), "ap-agent-process-")),
    children: ChildProcess[] = [];
  let killAfterClaim = false,
    claimStored: () => void = () => {},
    calls = 0;
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      const body = JSON.parse(Buffer.concat(chunks).toString()),
        args = jsonToConvex(body.args[0]) as Record<string, unknown>;
      if (
        req.url !== "/api/mutation" ||
        ![
          "apCaseAgent:claim",
          "apCaseAgent:advance",
          "apCaseAgent:failed",
        ].includes(body.path)
      )
        throw Error("Unexpected worker capability");
      calls++;
      const value = await f.t.mutation(
        makeFunctionReference<"mutation">(body.path),
        args,
      );
      if (killAfterClaim && body.path === "apCaseAgent:claim" && value) {
        killAfterClaim = false;
        claimStored();
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          status: "success",
          value: convexToJson(value),
          logLines: [],
        }),
      );
    } catch {
      res.statusCode = 560;
      res.end(
        JSON.stringify({
          status: "error",
          errorMessage: "Scoped test RPC rejected",
          logLines: [],
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number },
    config = join(dir, "agent.json");
  writeFileSync(
    config,
    JSON.stringify({
      convexUrl: `http://127.0.0.1:${address.port}`,
      scope: f.scope,
      apCredential: { seatId: f.ap.seatId, token: f.ap.token },
      paymentsCredential: { seatId: "payments", token: "token-payments" },
    }),
    { mode: 0o600 },
  );
  const start = () => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        resolve("scripts/ap-case-agent.ts"),
        "--config",
        config,
        "--once",
      ],
      {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: tmpdir(),
          NO_COLOR: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    children.push(child);
    let output = "";
    child.stdout!.on("data", (c) => {
      output += String(c);
    });
    child.stderr!.resume();
    return {
      child,
      done: once(child, "exit").then(([code, signal]) => ({
        code,
        signal,
        output,
      })),
    };
  };
  try {
    const input = packet("PROCESS-CASE");
    const id = (await f.t.mutation(refs.ingest, { ...f.ap, input })).caseId;
    const captured = new Promise<void>((resolve) => {
      claimStored = resolve;
    });
    killAfterClaim = true;
    const first = start();
    await captured;
    first.child.kill("SIGKILL");
    expect((await first.done).signal).toBe("SIGKILL");
    // Controlled expiry avoids a 30s test sleep; the actual worker process is killed.
    await f.t.run(async (ctx) => {
      const w = await ctx.db.query("apCaseWork").first();
      expect(w?.status).toBe("leased");
      await ctx.db.patch(w!._id, {
        leaseUntil: Date.now() - 1,
        nextCheckAt: Date.now() - 1,
      });
    });
    const second = await start().done;
    expect(second.code).toBe(0);
    expect(JSON.parse(second.output)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ caseId: id, stage: "field_review" }),
      ]),
    );
    const d = await f.get(id);
    await f.fieldReviewer.mutation(refs.review, {
      scope: f.scope,
      input: f.request(d),
    });
    await f.human.mutation(refs.approve, {
      scope: f.scope,
      input: {
        ...f.request(await f.get(id), "approve"),
        acceptedCents: d.candidate!.totalCents,
      },
    });
    await f.t.run(async (ctx) => {
      const w = await ctx.db.query("apCaseWork").first();
      await ctx.db.patch(w!._id, { nextCheckAt: Date.now() - 1 });
    });
    expect((await start().done).code).toBe(0);
    const state = await f.t.run(async (ctx) => ({
      work: await ctx.db.query("apCaseWork").first(),
      versions: await ctx.db.query("demoVersions").collect(),
      commands: await ctx.db.query("demoCommands").collect(),
    }));
    expect(state.work?.stage).toBe("payment_authorization");
    expect(state.versions).toHaveLength(1);
    expect(state.commands).toHaveLength(0);
    expect(calls).toBeGreaterThan(3);
    if (process.env.AP_AGENT_EVIDENCE_DIR)
      writeFileSync(
        join(process.env.AP_AGENT_EVIDENCE_DIR, "agent-process-recovery.json"),
        JSON.stringify(
          {
            classification:
              "actual child CLI processes and HTTP; retained Convex-test backend in parent; lease expiry advanced by fixture; no external provider",
            caseId: id,
            scope: f.scope,
            killedSignal: "SIGKILL",
            restartExitCode: second.code,
            recoveredWorkerOutput: JSON.parse(second.output),
            rpcCalls: calls,
            finalWork: {
              status: state.work?.status,
              stage: state.work?.stage,
              generation: state.work?.generation,
              owner: state.work?.owner,
            },
            proposalCount: state.versions.length,
            commandCount: state.commands.length,
            checks: {
              actualProcessKilledAfterClaim: true,
              newProcessRecovered: true,
              oneProposal: true,
              independentPaymentAuthorizationStillRequired: true,
            },
          },
          null,
          2,
        ) + "\n",
      );
  } finally {
    for (const c of children)
      if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
