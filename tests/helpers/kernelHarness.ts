import type { RegisteredMutation } from "convex/server";
import type { MutationCtx } from "../../convex/_generated/server";
import type { Doc, Id, TableNames } from "../../convex/_generated/dataModel";
import { sha256Hex } from "../../convex/lib/kernel";
import type { Role } from "../../src/core/roles";

type Row = Record<string, unknown> & { _id: string; _creationTime: number };

// Convex retains _handler at runtime but strips it from its published declarations.
export function mutationHandler<A extends Record<string, unknown>, R>(mutation: RegisteredMutation<"public", A, R>) {
  return (mutation as unknown as { _handler: (ctx: MutationCtx, args: A) => R })._handler;
}

/**
 * Minimal DB double for kernel handler tests. Returned failures deliberately retain
 * writes, just like Convex mutations; no transaction rollback is simulated here.
 * Live smoke tests separately exercise the actual Convex runtime and schema.
 */
export function kernelHarness() {
  const tables = new Map<string, Map<string, Row>>();
  const tableOf = new Map<string, string>();
  let nextId = 0;
  const tableFor = (id: string) => tableOf.get(id) ?? id.split(":")[0]!;
  function rows(table: string) {
    let result = tables.get(table);
    if (!result) tables.set(table, result = new Map());
    return result;
  }
  const db = {
    async insert(table: string, value: Record<string, unknown>) {
      const id = (value._seedId as string | undefined) ?? `${table}:${++nextId}`;
      const { _seedId: _s, ...rest } = value;
      tableOf.set(id, table);
      rows(table).set(id, structuredClone({ ...rest, _id: id, _creationTime: ++nextId }));
      return id;
    },
    normalizeId(table: string, id: string) {
      return rows(table).has(id) ? id : null;
    },
    async get(id: string) {
      return structuredClone(rows(tableFor(id)).get(id) ?? null);
    },
    async patch(id: string, value: Record<string, unknown>) {
      const table = rows(tableFor(id));
      const row = table.get(id);
      if (!row) throw new Error(`missing row ${id}`);
      table.set(id, structuredClone({ ...row, ...value }));
    },
    async delete(id: string) {
      rows(tableFor(id)).delete(id);
    },
    query(table: string) {
      const filters: [string, unknown][] = [];
      const predicates: ((row: Row) => boolean)[] = [];
      let indexName = "";
      type Expression = (row: Row) => unknown;
      const evaluate = (value: unknown, row: Row) => typeof value === "function" ? (value as Expression)(row) : value;
      const expressions = {
        field: (field: string) => (row: Row) => row[field],
        eq: (a: unknown, b: unknown) => (row: Row) => evaluate(a, row) === evaluate(b, row),
        lt: (a: unknown, b: unknown) => (row: Row) => (evaluate(a, row) as number) < (evaluate(b, row) as number),
        lte: (a: unknown, b: unknown) => (row: Row) => (evaluate(a, row) as number) <= (evaluate(b, row) as number),
        or: (...values: Expression[]) => (row: Row) => values.some((value) => value(row)),
      };
      const query = {
        withIndex(_name: string, build: (q: { eq: (field: string, value: unknown) => unknown }) => unknown) {
          indexName = _name;
          const index = { eq(field: string, value: unknown) { filters.push([field, value]); return index; } };
          build(index);
          return query;
        },
        filter(build: (q: typeof expressions) => (row: Row) => boolean) {
          predicates.push(build(expressions));
          return query;
        },
        async collect() {
          const matches = [...rows(table).values()].filter((row) =>
            filters.every(([field, value]) => row[field] === value) && predicates.every((test) => test(row)));
          if (indexName === "by_run_role_status") matches.sort((a, b) => (a.priority as number) - (b.priority as number));
          return structuredClone(matches);
        },
        async first() {
          return (await query.collect())[0] ?? null;
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
      return structuredClone([...rows(table).values()]) as unknown as Doc<T>[];
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
    /** Bills must cite a received document: seed one under the id a fixture refers to. */
    async document(runId: string, id = "document-1") {
      await db.insert("events", {
        _seedId: id, runId, type: "document.received", externalId: id, occurredOn: "2026-01-02",
        payload: { kind: "invoice", text: "regression invoice" }, recordedAt: 0,
      });
    },
  };
}
