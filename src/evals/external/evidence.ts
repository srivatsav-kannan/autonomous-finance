import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ToolDef } from "../../agents/llm";
import type { BenchmarkTask, Trace } from "./types";

export const DEFAULT_DATA = path.resolve("var/benchmarks/finance-eight");
export function python(): string {
  const local = path.resolve("var/benchmarks/.venv/bin/python");
  return process.env.EXTERNAL_BENCH_PYTHON ?? (fs.existsSync(local) ? local : "python3");
}
export function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
export function evidencePath(root: string, task: BenchmarkTask): string {
  const publicRoot = fs.realpathSync(path.join(root, "public"));
  const file = fs.realpathSync(path.resolve(root, task.evidence));
  if (!file.startsWith(publicRoot + path.sep) || path.extname(file) !== ".sqlite") throw new Error("Evidence must be a public SQLite file");
  if (sha256(file) !== task.evidenceSha256) throw new Error(`Evidence changed for ${task.id}; prepare the pinned batch again`);
  return file;
}
export async function evidenceRequest(db: string, request: Record<string, unknown>): Promise<any> {
  return await new Promise((resolve, reject) => {
    const child = spawn(python(), [path.resolve("scripts/external-bench/evidence.py"), db], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, LANG: "en_US.UTF-8" } });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Evidence query exceeded 15 seconds")); }, 15000);
    child.stdout.on("data", (data) => {
      out += String(data);
      if (out.length > 1_000_000) { child.kill("SIGKILL"); reject(new Error("Evidence response exceeded its size limit")); }
    });
    child.stderr.on("data", (data) => { err = (err + String(data)).slice(-4000); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(out);
        if (code !== 0 || parsed.error) reject(new Error(parsed.error ?? err));
        else resolve(parsed);
      } catch { reject(new Error(`Evidence worker failed (${code}): ${err || out}`)); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(request));
  });
}

export function evidenceTools(db: string, trace: Trace[], seat: string): ToolDef[] {
  function tool(name: string, description: string, schema: z.ZodType, operation: string): ToolDef {
    return { name, description, schema, inputSchema: z.toJSONSchema(schema) as Record<string, unknown>, run: async (input) => {
      const output = await evidenceRequest(db, { ...(input as Record<string, unknown>), operation });
      trace.push({ seat, tool: name, input, output });
      return output;
    } };
  }
  return [
    tool("list_documents", "List all source documents and SQL tables, including column names. XLSX c1=A, c2=B, etc.; _row is the original worksheet row. JSON arrays/objects in cells are queryable with SQLite JSON functions.", z.object({}).strict(), "list"),
    tool("read_document", "Read extracted source text, including PDF pages, spreadsheet rows and formulas. Paginate with offset. Only listed public documents are available.", z.object({ path: z.string(), offset: z.number().int().min(0), length: z.number().int().min(1).max(16000) }).strict(), "read"),
    tool("query_evidence", "Execute read-only SQLite SELECT against source tables. Supports joins, CTEs, SUM/AVG, arithmetic and JSON functions. Max 200 rows; use aggregates for large tables. All data is public task evidence. Never executes shell or arbitrary code.", z.object({ sql: z.string().max(12000) }).strict(), "query"),
  ];
}
