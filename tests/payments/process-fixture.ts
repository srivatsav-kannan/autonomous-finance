import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { makeFunctionReference } from "convex/server";
import type { KernelTransport } from "../../src/payments/evidence";

/**
 * A real worker process talks to the parent's in-memory Convex fixture. This
 * proves process isolation and bank persistence, not persistent Convex restart.
 * Expose only dispatcher operations on a private loopback listener.
 */
export async function paymentKernelBridge(kernel: KernelTransport) {
  const token = randomBytes(24).toString("hex");
  const allowed = new Set(["demoPayments:claim", "demoPayments:heartbeat", "demoPayments:complete", "demoPayments:fail"]);
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/mutation" || request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(403).end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 128 * 1024) throw new Error("Oversized test request");
        chunks.push(chunk);
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { name: string; args: Record<string, unknown> };
      if (!allowed.has(payload.name)) throw new Error("Unsupported test operation");
      const result = await kernel.mutation(makeFunctionReference<"mutation">(payload.name), payload.args);
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ value: result }));
    } catch (error) {
      response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: error instanceof Error ? error.message : "Test bridge failure" }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    token,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

export async function runPaymentChild(configPath: string, crash: "before-send" | "after-send" | "none") {
  return new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/testing/payment-dispatch-child.ts", configPath, crash], {
      cwd: process.cwd(),
      // No application, provider or identity credentials inherited from the user.
      env: { PATH: process.env.PATH, NODE_NO_WARNINGS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    const deadline = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => { clearTimeout(deadline); reject(error); });
    child.on("exit", code => {
      clearTimeout(deadline);
      if (code === 0 || code === 86) resolve({ code, stdout });
      else reject(new Error(`Payment test worker exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}
