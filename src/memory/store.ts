import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { canMerge, type Capabilities } from "../core/roles";
import { controlledReason, schemaFor } from "./schemas";

const run = promisify(execFile);

export interface Author {
  seatId: string;
  name: string;
}

export interface FileChange {
  path: string;
  data: unknown; // parsed YAML content; null deletes the file
}

export interface CommitInfo {
  sha: string;
  author: string;
  email: string;
  at: string;
  subject: string;
  trailers: Record<string, string>;
}

export class MemoryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/**
 * Company memory as a bare git repository of schema-validated YAML.
 *
 * Writes never touch a working tree: each commit is built with a private index
 * (GIT_INDEX_FILE) and published with a compare-and-swap `update-ref`, so concurrent
 * writers retry instead of overwriting each other. Controlled changes (policies, vendor
 * bank details, seats) go to proposal branches and need a different seat to merge.
 */
export class MemoryStore {
  private idempotencyKeys = new Map<string, string>();
  private indexed = false;

  constructor(readonly dir: string) {}

  static emailFor(seatId: string): string {
    return `${seatId}@agents.sweetgreen.sim`;
  }

  async git(args: string[], opts: { input?: string; env?: Record<string, string> } = {}): Promise<string> {
    const child = run("git", ["--git-dir", this.dir, ...args], {
      env: { ...process.env, ...opts.env },
      maxBuffer: 64 * 1024 * 1024,
    });
    if (opts.input !== undefined) {
      child.child.stdin?.end(opts.input);
    } else {
      child.child.stdin?.end();
    }
    const { stdout } = await child;
    return stdout;
  }

  async init(): Promise<void> {
    if (fs.existsSync(path.join(this.dir, "HEAD"))) return;
    fs.mkdirSync(this.dir, { recursive: true });
    await run("git", ["init", "--bare", "--initial-branch=main", this.dir]);
    await this.git(["config", "core.logAllRefUpdates", "true"]);
    const emptyTree = (await this.git(["hash-object", "-t", "tree", "-w", "--stdin"], { input: "" })).trim();
    const sha = (
      await this.git(["commit-tree", emptyTree, "-m", "Company memory initialized"], { env: this.authorEnv({ seatId: "system", name: "System" }) })
    ).trim();
    await this.git(["update-ref", "refs/heads/main", sha]);
  }

  private authorEnv(author: Author): Record<string, string> {
    return {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: MemoryStore.emailFor(author.seatId),
      GIT_COMMITTER_NAME: "Memory Service",
      GIT_COMMITTER_EMAIL: "memory@agents.sweetgreen.sim",
    };
  }

  async head(ref = "main"): Promise<string> {
    return (await this.git(["rev-parse", `refs/heads/${ref}`])).trim();
  }

  async exists(p: string, ref = "main"): Promise<boolean> {
    try {
      await this.git(["cat-file", "-e", `refs/heads/${ref}:${p}`]);
      return true;
    } catch {
      return false;
    }
  }

  async read<T = unknown>(p: string, ref = "main"): Promise<T | undefined> {
    try {
      const text = await this.git(["show", `${ref.match(/^[0-9a-f]{40}$/) ? ref : `refs/heads/${ref}`}:${p}`]);
      return YAML.parse(text) as T;
    } catch {
      return undefined;
    }
  }

  async readText(p: string, ref = "main"): Promise<string | undefined> {
    try {
      return await this.git(["show", `${ref.match(/^[0-9a-f]{40}$/) ? ref : `refs/heads/${ref}`}:${p}`]);
    } catch {
      return undefined;
    }
  }

  async list(prefix = "", ref = "main"): Promise<string[]> {
    const out = await this.git(["ls-tree", "-r", "--name-only", `refs/heads/${ref}`, "--", prefix || "."]);
    return out.split("\n").filter(Boolean);
  }

  async blobSha(p: string, ref = "main"): Promise<string | undefined> {
    try {
      return (await this.git(["rev-parse", `refs/heads/${ref}:${p}`])).trim();
    } catch {
      return undefined;
    }
  }

  private async loadIdempotencyIndex(): Promise<void> {
    if (this.indexed) return;
    const out = await this.git(["log", "--all", "--format=%H%x1f%(trailers:key=Idempotency-Key,valueonly,separator=)"]);
    for (const line of out.split("\n")) {
      const [sha, key] = line.split("\x1f");
      if (sha && key?.trim()) this.idempotencyKeys.set(key.trim(), sha);
    }
    this.indexed = true;
  }

  private validate(p: string, data: unknown): void {
    const schema = schemaFor(p);
    if (!schema) throw new MemoryError("unknown_path", `no schema governs ${p}; memory only stores known kinds of records`);
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      throw new MemoryError("schema", `${p}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    }
  }

  /** Build a commit on `branch` (created from `base` if missing) with CAS publication and retry. */
  private async commitFiles(
    branch: string,
    base: string,
    changes: FileChange[],
    author: Author,
    message: string,
    trailers: Record<string, string>,
    check: (parentRef: string) => Promise<void>,
  ): Promise<string> {
    // Serialize writers inside this process; CAS + retry still protects against other processes.
    const prior = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((r) => (release = r));
    await prior;
    try {
      return await this.commitFilesUnlocked(branch, base, changes, author, message, trailers, check);
    } finally {
      release();
    }
  }

  private queue: Promise<void> = Promise.resolve();

  private async commitFilesUnlocked(
    branch: string,
    base: string,
    changes: FileChange[],
    author: Author,
    message: string,
    trailers: Record<string, string>,
    check: (parentRef: string) => Promise<void>,
  ): Promise<string> {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 5 + Math.random() * 20 * attempt));
      let parent: string;
      let oldRef: string;
      try {
        parent = await this.head(branch);
        oldRef = parent;
      } catch {
        parent = await this.head(base);
        oldRef = "0000000000000000000000000000000000000000";
      }
      await check(parent);
      const index = path.join(this.dir, `index-${randomBytes(6).toString("hex")}`);
      const env = { ...this.authorEnv(author), GIT_INDEX_FILE: index };
      try {
        await this.git(["read-tree", parent], { env });
        for (const c of changes) {
          if (c.data === null) {
            await this.git(["update-index", "--force-remove", "--", c.path], { env });
            continue;
          }
          const text = YAML.stringify(c.data, { lineWidth: 0 });
          const blob = (await this.git(["hash-object", "-w", "--stdin"], { input: text })).trim();
          await this.git(["update-index", "--add", "--cacheinfo", `100644,${blob},${c.path}`], { env });
        }
        const tree = (await this.git(["write-tree"], { env })).trim();
        const trailerText = Object.entries(trailers).map(([k, v]) => `${k}: ${v}`).join("\n");
        const body = trailerText ? `${message}\n\n${trailerText}\n` : `${message}\n`;
        const sha = (await this.git(["commit-tree", tree, "-p", parent, "-F", "-"], { env, input: body })).trim();
        try {
          await this.git(["update-ref", `refs/heads/${branch}`, sha, oldRef]);
          return sha;
        } catch {
          // Someone else moved the branch first: rebuild on the new head and re-run the checks.
          continue;
        }
      } finally {
        fs.rmSync(index, { force: true });
      }
    }
    throw new MemoryError("contention", `could not publish to ${branch} after retries`);
  }

  /**
   * Direct write to main. Allowed only for uncontrolled changes (notes, credits, decision records).
   * Decision records are immutable: writing an existing decision path is rejected.
   */
  async write(opts: {
    changes: FileChange[];
    author: Author;
    message: string;
    trailers?: Record<string, string>;
    idempotencyKey?: string;
  }): Promise<{ sha: string; replayed: boolean }> {
    await this.loadIdempotencyIndex();
    if (opts.idempotencyKey && this.idempotencyKeys.has(opts.idempotencyKey)) {
      return { sha: this.idempotencyKeys.get(opts.idempotencyKey)!, replayed: true };
    }
    for (const c of opts.changes) if (c.data !== null) this.validate(c.path, c.data);
    const trailers = { ...(opts.trailers ?? {}), ...(opts.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : {}) };
    const sha = await this.commitFiles("main", "main", opts.changes, opts.author, opts.message, trailers, async (parent) => {
      for (const c of opts.changes) {
        const before = await this.read(c.path, parent);
        if (c.path.startsWith("decisions/") && before !== undefined) {
          throw new MemoryError("immutable", `${c.path} already exists; decision records are never rewritten`);
        }
        const reason = controlledReason(c.path, before, c.data);
        if (reason) throw new MemoryError("controlled", `${reason}; open a proposal instead`);
      }
    });
    if (opts.idempotencyKey) this.idempotencyKeys.set(opts.idempotencyKey, sha);
    return { sha, replayed: false };
  }

  /** Seed or admin bootstrap: bypasses the controlled-change rule (still schema-validated). */
  async bootstrap(changes: FileChange[], author: Author, message: string): Promise<string> {
    for (const c of changes) if (c.data !== null) this.validate(c.path, c.data);
    return await this.commitFiles("main", "main", changes, author, message, { "Change-Type": "bootstrap" }, async () => {});
  }

  /** Open a proposal branch for a controlled change. Validates now so bad proposals fail fast. */
  async propose(opts: {
    id: string;
    changes: FileChange[];
    author: Author;
    message: string;
    trailers?: Record<string, string>;
  }): Promise<{ branch: string; sha: string }> {
    for (const c of opts.changes) if (c.data !== null) this.validate(c.path, c.data);
    const branch = `proposal/${opts.id}`;
    const sha = await this.commitFiles(branch, "main", opts.changes, opts.author, opts.message,
      { ...(opts.trailers ?? {}), "Proposal-Id": opts.id, "Proposed-By": opts.author.seatId }, async () => {});
    return { branch, sha };
  }

  /** Files a proposal changes relative to the main commit it branched from. */
  async proposalPaths(id: string): Promise<{ base: string; head: string; paths: string[]; proposer: string }> {
    const branch = `proposal/${id}`;
    const head = await this.head(branch);
    const base = (await this.git(["merge-base", "refs/heads/main", head])).trim();
    const paths = (await this.git(["diff", "--name-only", base, head])).split("\n").filter(Boolean);
    const proposer = (await this.git(["log", "-1", "--format=%(trailers:key=Proposed-By,valueonly,separator=)", head])).trim();
    return { base, head, paths, proposer };
  }

  /**
   * Merge a proposal. Segregation of duties: the approver must not be the proposer and must hold
   * merge rights for every path touched. If main changed the same files since the proposal was
   * opened, the proposal is stale and must be re-proposed (no silent overwrite).
   */
  async merge(opts: { id: string; approver: Author; caps: Capabilities; note: string }): Promise<{ sha: string }> {
    const { base, head, paths, proposer } = await this.proposalPaths(opts.id);
    if (proposer === opts.approver.seatId) throw new MemoryError("sod", "the proposer of a change cannot merge it");
    for (const p of paths) {
      if (!canMerge(opts.caps, p)) throw new MemoryError("forbidden", `${opts.approver.seatId} may not approve changes to ${p}`);
    }
    const mainHead = await this.head("main");
    const changedOnMain = (await this.git(["diff", "--name-only", base, mainHead])).split("\n").filter(Boolean);
    const overlap = paths.filter((p) => changedOnMain.includes(p));
    if (overlap.length) throw new MemoryError("stale", `main changed ${overlap.join(", ")} since the proposal; re-propose`);

    const index = path.join(this.dir, `index-${randomBytes(6).toString("hex")}`);
    const env = { ...this.authorEnv(opts.approver), GIT_INDEX_FILE: index };
    try {
      await this.git(["read-tree", mainHead], { env });
      for (const p of paths) {
        const exists = await this.git(["cat-file", "-e", `${head}:${p}`]).then(() => true, () => false);
        if (!exists) {
          await this.git(["update-index", "--force-remove", "--", p], { env });
          continue;
        }
        const blob = (await this.git(["rev-parse", `${head}:${p}`])).trim();
        await this.git(["update-index", "--add", "--cacheinfo", `100644,${blob},${p}`], { env });
      }
      const tree = (await this.git(["write-tree"], { env })).trim();
      const body = `Merge proposal ${opts.id}: ${opts.note}\n\nApproved-By: ${opts.approver.seatId}\nProposal-Id: ${opts.id}\n`;
      const sha = (await this.git(["commit-tree", tree, "-p", mainHead, "-p", head, "-F", "-"], { env, input: body })).trim();
      await this.git(["update-ref", "refs/heads/main", sha, mainHead]);
      await this.git(["update-ref", "-d", `refs/heads/proposal/${opts.id}`]);
      await this.git(["update-ref", `refs/merged/${opts.id}`, head]);
      return { sha };
    } finally {
      fs.rmSync(index, { force: true });
    }
  }

  async rejectProposal(id: string): Promise<void> {
    const head = await this.head(`proposal/${id}`);
    await this.git(["update-ref", `refs/rejected/${id}`, head]);
    await this.git(["update-ref", "-d", `refs/heads/proposal/${id}`]);
  }

  async log(opts: { path?: string; limit?: number; ref?: string } = {}): Promise<CommitInfo[]> {
    const args = ["log", `--max-count=${opts.limit ?? 50}`, "--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%(trailers:unfold,separator=%x1e)%x1d", opts.ref ?? "refs/heads/main"];
    if (opts.path) {
      // Full history so approval merges show up in a file's log, not just the proposer's commit.
      args.splice(1, 0, "--full-history");
      args.push("--", opts.path);
    }
    const out = await this.git(args);
    return out
      .split("\x1d")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((rec) => {
        const [sha = "", author = "", email = "", at = "", subject = "", trailerText = ""] = rec.split("\x1f");
        const trailers: Record<string, string> = {};
        for (const t of trailerText.split("\x1e")) {
          const i = t.indexOf(":");
          if (i > 0) trailers[t.slice(0, i).trim()] = t.slice(i + 1).trim();
        }
        return { sha, author, email, at, subject, trailers };
      });
  }

  /** Who last changed each line of a record, and in which commit. */
  async blame(p: string): Promise<{ line: number; sha: string; author: string; text: string }[]> {
    const out = await this.git(["blame", "--line-porcelain", "refs/heads/main", "--", p]);
    const rows: { line: number; sha: string; author: string; text: string }[] = [];
    let cur: { sha: string; author: string; line: number } | null = null;
    for (const l of out.split("\n")) {
      const header = /^([0-9a-f]{40}) \d+ (\d+)/.exec(l);
      if (header) cur = { sha: header[1]!, line: Number(header[2]), author: "" };
      else if (l.startsWith("author ") && cur) cur.author = l.slice(7);
      else if (l.startsWith("\t") && cur) rows.push({ ...cur, text: l.slice(1) });
    }
    return rows;
  }

  async listProposals(): Promise<string[]> {
    const out = await this.git(["for-each-ref", "--format=%(refname:strip=3)", "refs/heads/proposal/"]);
    return out.split("\n").filter(Boolean);
  }

  async tag(name: string, message: string, author: Author): Promise<string> {
    await this.git(["tag", "-a", name, "-m", message, "refs/heads/main"], { env: this.authorEnv(author) });
    return (await this.git(["rev-parse", `refs/tags/${name}^{commit}`])).trim();
  }
}
