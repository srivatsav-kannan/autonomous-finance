import { randomBytes } from "node:crypto";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { SeatClient, api } from "../core/kernel-client";
import type { Role } from "../core/roles";
import { MemoryStore, type FileChange } from "../memory/store";
import type { Decision, Vendor, Store } from "../memory/schemas";
import { BUILTIN_PARSERS, loadArParsers, loadMemoryParsers, type ArParser, type Parser } from "../integrations/parsers";
import { WorldBank } from "../world/bank";
import { emptyUsage, type Usage } from "./llm";

export type Task = Doc<"tasks">;

export interface HandlerResult {
  outcome: string; // short machine-readable outcome, e.g. "approved", "held", "rejected", "posted"
  summary?: string;
  waiting?: boolean; // task parked until an ask is answered
  deferMs?: number; // requeue later without spending an attempt (waiting on other work, not failing)
}

/** Everything a seat needs to do its job. The kernel, not this object, decides what is allowed. */
export class SeatRuntime {
  readonly kernel: SeatClient;
  readonly usage: Usage = emptyUsage();
  private parsers: Parser[] | null = null;
  private parsersSha: string | null = null;
  private arParsers: ArParser[] | null = null;
  private arParsersSha: string | null = null;
  private vendorCache: Map<string, { vendor: Vendor; sha: string }> | null = null;

  constructor(
    readonly runId: string,
    readonly seat: { seatId: string; role: Role; name: string; effort?: string },
    token: string,
    readonly mem: MemoryStore,
    readonly bank: WorldBank,
  ) {
    this.kernel = new SeatClient(runId, seat.seatId, token);
  }

  get author() {
    return { seatId: this.seat.seatId, name: this.seat.name };
  }

  async simDate(): Promise<string> {
    const run = (await this.kernel.client.query(api.admin.runs, {})).find((r) => r.runId === this.runId);
    return run?.simDate ?? "2026-01-01";
  }

  async event(eventId: Id<"events">): Promise<Doc<"events">> {
    const e = await this.kernel.client.query(api.admin.event, { runId: this.runId, eventId });
    if (!e) throw new Error(`event ${eventId} not found`);
    return e;
  }

  async eventsOfType(type: string, from?: string, to?: string): Promise<Doc<"events">[]> {
    return await this.kernel.client.query(api.admin.eventsOfType, { runId: this.runId, type, from, to });
  }

  async parsersNow(refresh = false): Promise<Parser[]> {
    const head = await this.mem.head();
    if (!this.parsers || refresh || this.parsersSha !== head) {
      this.parsers = [...BUILTIN_PARSERS, ...(await loadMemoryParsers(this.mem, head))];
      this.parsersSha = head;
    }
    return this.parsers;
  }

  /** Parsers for customer billing documents: only agent-written ones, approved into memory. */
  async arParsersNow(): Promise<ArParser[]> {
    const head = await this.mem.head();
    if (!this.arParsers || this.arParsersSha !== head) {
      this.arParsers = await loadArParsers(this.mem, head);
      this.arParsersSha = head;
    }
    return this.arParsers;
  }

  async vendors(refresh = false): Promise<Map<string, { vendor: Vendor; sha: string }>> {
    if (!this.vendorCache || refresh) {
      const map = new Map<string, { vendor: Vendor; sha: string }>();
      const head = await this.mem.head();
      for (const f of await this.mem.list("vendors/")) {
        const v = await this.mem.read<Vendor>(f);
        if (v) map.set(v.id, { vendor: v, sha: head });
      }
      this.vendorCache = map;
    }
    return this.vendorCache;
  }

  async vendor(id: string): Promise<{ vendor: Vendor; sha: string } | undefined> {
    const v = await this.mem.read<Vendor>(`vendors/${id}.yaml`);
    if (!v) return undefined;
    return { vendor: v, sha: await this.mem.head() };
  }

  async store(id: string): Promise<Store | undefined> {
    return await this.mem.read<Store>(`stores/${id}.yaml`);
  }

  /** Match a sender to a vendor by the email domain on file, never by display name alone. */
  async resolveVendorByEmail(from: string): Promise<{ vendor: Vendor; exactDomain: boolean } | undefined> {
    const domain = from.split("@")[1]?.toLowerCase() ?? "";
    const all = [...(await this.vendors()).values()].map((x) => x.vendor);
    const exact = all.find((v) => v.contacts.some((c) => c.email.split("@")[1]?.toLowerCase() === domain));
    if (exact) return { vendor: exact, exactDomain: true };
    // Look-alike domains (gsproduce-billing.example vs gsproduce.example) resolve to a vendor but flag it.
    const stem = domain.split(".")[0]?.split("-")[0] ?? "";
    const near = all.find((v) => v.contacts.some((c) => (c.email.split("@")[1] ?? "").split(".")[0] === stem));
    return near ? { vendor: near, exactDomain: false } : undefined;
  }

  async resolveVendorByName(name: string): Promise<Vendor | undefined> {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const all = [...(await this.vendors()).values()].map((x) => x.vendor);
    return all.find((v) => norm(v.legalName) === norm(name)) ?? all.find((v) => norm(name).includes(norm(v.legalName).slice(0, 10)));
  }

  /** Commit a change to company memory and mirror the commit into the kernel's index. */
  async commit(changes: FileChange[], message: string, trailers: Record<string, string> = {}, idempotencyKey?: string): Promise<string> {
    const { sha } = await this.mem.write({ changes, author: this.author, message, trailers, idempotencyKey });
    await this.mirrorCommit(sha);
    return sha;
  }

  /** Apply only the intended vendor changes against the current CAS-protected record. */
  async updateVendor(id: string, update: (current: Vendor) => Vendor, message: string, trailers: Record<string, string> = {}, idempotencyKey?: string): Promise<string> {
    const { sha } = await this.mem.update<Vendor>({ path: `vendors/${id}.yaml`, update, author: this.author, message, trailers, idempotencyKey });
    await this.mirrorCommit(sha);
    return sha;
  }

  private async mirrorCommit(sha: string): Promise<void> {
    this.vendorCache = null;
    // A previous attempt may have committed Git but failed before the kernel mirror.
    // recordCommit is idempotent by SHA; always send the persisted metadata on replay.
    const saved = await this.mem.commitInfo(sha);
    const result = await this.kernel.client.mutation(api.observe.recordCommit, {
      ...this.kernel.auth, sha, branch: "main", message: saved.subject, paths: saved.paths,
      trailers: { ...saved.trailers, "Git-Author": saved.author, "Git-Author-Email": saved.email },
    });
    if (!result.ok) throw new Error(`recordCommit failed: ${result.code} ${result.error}`);
  }

  async propose(id: string, changes: FileChange[], message: string, trailers: Record<string, string> = {}): Promise<{ branch: string; sha: string }> {
    const res = await this.mem.propose({ id, changes, author: this.author, message, trailers });
    await this.kernel.client.mutation(api.observe.recordCommit, {
      ...this.kernel.auth, sha: res.sha, branch: res.branch, message, paths: changes.map((c) => c.path), trailers,
    });
    return res;
  }

  /** Write an immutable decision record; returns its path and the memory SHA it was made under. */
  async decide(d: Omit<Decision, "id" | "seat" | "on"> & { on?: string; task?: string }): Promise<{ path: string; sha: string; memorySha: string }> {
    const on = d.on ?? (await this.simDate());
    const id = `${on}-${this.seat.seatId}-${randomBytes(3).toString("hex")}`;
    const path = `decisions/${on.slice(0, 7)}/${id}.yaml`;
    const memorySha = await this.mem.head();
    const record: Decision = { id, on, seat: this.seat.seatId, ...d, facts: d.facts, rules: d.rules };
    const sha = await this.commit([{ path, data: record }], `${d.outcome.toUpperCase()} ${d.kind} ${d.subject.id}: ${d.summary}`, {
      "Decision-Id": id,
      "Memory-Sha": memorySha,
      Confidence: d.confidence.toFixed(2),
      ...(d.task ? { "Task-Id": d.task } : {}),
    }, `decision:${d.task ?? id}:${d.kind}:${d.subject.id}`);
    const saved = await this.mem.commitInfo(sha);
    const savedPath = saved.paths.find((p) => p.startsWith("decisions/"));
    if (!savedPath) throw new Error(`decision commit ${sha} has no decision record`);
    // Older decision commits have no Memory-Sha trailer; their parent is the best
    // available pre-decision snapshot. New commits persist the exact snapshot read.
    return { path: savedPath, sha, memorySha: saved.trailers["Memory-Sha"] ?? saved.parent };
  }

  async ask(a: {
    to: string;
    severity: "info" | "decision" | "urgent";
    title: string;
    body: string;
    evidence?: { label: string; ref: string }[];
    options?: { id: string; label: string }[];
    taskId?: Id<"tasks">;
    paymentIntentId?: Id<"paymentIntents">;
    proposalBranch?: string;
  }) {
    return await this.kernel.client.mutation(api.asks.createAsk, {
      ...this.kernel.auth,
      to: a.to,
      severity: a.severity,
      title: a.title,
      body: a.body,
      evidence: a.evidence ?? [],
      options: a.options ?? [{ id: "ack", label: "Acknowledge" }],
      taskId: a.taskId,
      paymentIntentId: a.paymentIntentId,
      proposalBranch: a.proposalBranch,
    });
  }

  async handoff(type: string, role: Role, payload: unknown, key: string, parentTaskId?: Id<"tasks">, priority?: number) {
    const r = await this.kernel.client.mutation(api.tasks.createTask, {
      ...this.kernel.auth, type, role, payload, idempotencyKey: key, parentTaskId, priority,
    });
    if (!r.ok) throw new Error(`handoff ${type} -> ${role} failed: ${r.error}`);
    return r;
  }

  async note(kind: string, text: string, refs?: unknown) {
    await this.kernel.client.mutation(api.observe.note, { ...this.kernel.auth, kind, text, refs });
  }
}

export type Handler = (rt: SeatRuntime, task: Task) => Promise<HandlerResult>;
