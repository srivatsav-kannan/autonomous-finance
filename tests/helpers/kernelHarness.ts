import type { MutationCtx } from "../../convex/_generated/server";
import type { Doc, Id, TableNames } from "../../convex/_generated/dataModel";
import { sha256Hex } from "../../convex/lib/kernel";
import type { Role } from "../../src/core/roles";

type Row = Record<string, unknown> & { _id: string; _creationTime: number };

/**
 * Minimal DB double for kernel handler tests. Returned failures deliberately retain
 * writes, just like Convex mutations; no transaction rollback is simulated here.
 * Live smoke tests separately exercise the actual Convex runtime and schema.
 */
export function kernelHarness() {
  const tables = new Map<string, Map<string, Row>>();
  let nextId = 0;
  function rows(table: string) {
    let result = tables.get(table);
    if (!result) tables.set(table, result = new Map());
    return result;
  }
  const db = {
    async insert(table: string, value: Record<string, unknown>) {
      const id = `${table}:${++nextId}`;
      rows(table).set(id, structuredClone({ ...value, _id: id, _creationTime: nextId }));
      return id;
    },
    async get(id: string) {
      return structuredClone(rows(id.split(":")[0]!).get(id) ?? null);
    },
    async patch(id: string, value: Record<string, unknown>) {
      const table = rows(id.split(":")[0]!);
      const row = table.get(id);
      if (!row) throw new Error(`missing row ${id}`);
      table.set(id, structuredClone({ ...row, ...value }));
    },
    async delete(id: string) {
      rows(id.split(":")[0]!).delete(id);
    },
    query(table: string) {
      const filters: [string, unknown][] = [];
      const query = {
        withIndex(_name: string, build: (q: { eq: (field: string, value: unknown) => unknown }) => unknown) {
          const index = { eq(field: string, value: unknown) { filters.push([field, value]); return index; } };
          build(index);
          return query;
        },
        async collect() {
          return structuredClone([...rows(table).values()].filter((row) => filters.every(([field, value]) => row[field] === value)));
        },
        async unique() {
          const matches = await query.collect();
          if (matches.length > 1) throw new Error(`non-unique ${table} lookup`);
          return matches[0] ?? null;
        },
      };
      return query;
    },
  };
  const ctx = { db } as unknown as MutationCtx;
  return {
    ctx,
    all<T extends TableNames>(table: T): Doc<T>[] {
      return structuredClone([...rows(table).values()]) as Doc<T>[];
    },
    async seed<T extends TableNames>(table: T, value: Omit<Doc<T>, "_id" | "_creationTime">): Promise<Id<T>> {
      return await db.insert(table, value) as Id<T>;
    },
    async setup(role: Role = "ap_clerk") {
      const runId = "regression-run";
      const seatId = `${role}-1`;
      const token = "test-seat-token";
      await db.insert("runs", { runId, label: "Regression", company: "test", simDate: "2026-01-02", status: "active", createdAt: 0 });
      await db.insert("seats", { runId, seatId, role, name: role, kind: "agent", capabilities: {}, status: "active", tokenHash: await sha256Hex(token), createdAt: 0 });
      await db.insert("periods", { runId, period: "2026-01", status: "open" });
      return { runId, seatId, token };
    },
  };
}
