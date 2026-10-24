import { describe, expect, it, vi } from "vitest";
import { processPayroll } from "../src/agents/handlers/books";
import type { SeatRuntime, Task } from "../src/agents/runtime";

type Employee = { id: string; name: string; store: string; status: string; terminatedOn?: string };
type Event = { type: string; externalId: string; occurredOn: string; payload: unknown; _creationTime: number };
const active: Employee = { id: "employee-1", name: "Active Employee", store: "store-1", status: "active" };
const snapshot = (employees = [active], asOf = "2026-01-01", created = 1): Event => ({
  type: "hr.roster", externalId: `roster-${asOf}`, occurredOn: asOf, payload: { asOf, employees }, _creationTime: created,
});
const termination = (effective: string, employeeId = active.id): Event => ({
  type: "hr.roster_change", externalId: `termination-${employeeId}`, occurredOn: "2026-01-01", _creationTime: 2,
  payload: { employeeId, name: "Employee", store: "store-1", change: "terminated", effective },
});

async function runPayroll(events: Event[], employees = [{ id: active.id, name: active.name, grossCents: 10000 }]) {
  const mutation = vi.fn(async (_function: unknown, args: { lines: { debit: number; credit: number }[] }) => {
    // Mirror the live ledger's rejection of zero-dollar entries.
    if (args.lines.some((line) => line.debit === 0 && line.credit === 0)) return { ok: false, code: "invalid_entry", error: "zero line" };
    return { ok: true, entryId: "entry-1" };
  });
  const decide = vi.fn(async () => ({ path: "decisions/payroll.yaml", sha: "decision-sha", memorySha: "memory-sha" }));
  const ask = vi.fn(async () => ({ ok: true }));
  const eventsOfType = vi.fn(async (type: string, _from?: string, to?: string) => events.filter((event) => event.type === type && (!to || event.occurredOn <= to)));
  const rt = {
    event: async () => ({ externalId: "payroll-event", payload: { registerId: "register-1", store: "store-1", payDate: "2026-01-14", employees } }),
    eventsOfType, decide, ask, kernel: { auth: { runId: "run-1", seatId: "payroll", token: "token" }, client: { mutation } },
  } as unknown as SeatRuntime;
  const task = { _id: "task-1", payload: { eventId: "payroll-event" } } as unknown as Task;
  const result = await processPayroll(rt, task);
  return { result, mutation, decide, ask, eventsOfType };
}

describe("payroll HR authorization", () => {
  it("accrues an active employee in the register's store with roster evidence", async () => {
    const r = await runPayroll([snapshot()]);
    expect(r.result.outcome).toBe("posted");
    expect(r.mutation).toHaveBeenCalledOnce();
    expect(r.mutation.mock.calls[0]![1].lines).toMatchObject([{ debit: 10000, credit: 0 }, { debit: 0, credit: 10000 }]);
    expect(r.ask).not.toHaveBeenCalled();
    expect(r.eventsOfType).toHaveBeenCalledWith("hr.roster", undefined, "2026-01-14");
    expect(r.decide).toHaveBeenCalledWith(expect.objectContaining({ facts: expect.arrayContaining([expect.objectContaining({ key: "roster", source: { kind: "event", ref: "roster-2026-01-01" } })]) }));
  });

  it.each([
    ["unknown employee", [snapshot()], [{ id: "unknown", name: "Unknown Person", grossCents: 123456 }], /not on the HR roster/],
    ["missing roster", [], [{ id: active.id, name: active.name, grossCents: 123456 }], /no HR roster/],
    ["wrong store", [snapshot([{ ...active, store: "store-2" }])], [{ id: active.id, name: active.name, grossCents: 123456 }], /store-2/],
    ["inactive employee", [snapshot([{ ...active, status: "inactive" }])], [{ id: active.id, name: active.name, grossCents: 123456 }], /inactive/],
    ["terminated snapshot", [snapshot([{ ...active, status: "terminated", terminatedOn: "2026-01-03" }])], [{ id: active.id, name: active.name, grossCents: 123456 }], /terminated/],
    ["effective termination", [snapshot(), termination("2026-01-03")], [{ id: active.id, name: active.name, grossCents: 123456 }], /terminated/],
    ["termination on pay date", [snapshot(), termination("2026-01-14")], [{ id: active.id, name: active.name, grossCents: 123456 }], /terminated/],
    ["only future roster", [snapshot([active], "2026-02-01")], [{ id: active.id, name: active.name, grossCents: 123456 }], /no HR roster/],
  ] as const)("holds all pay for %s without attempting a zero accrual", async (_label, events, employees, reason) => {
    const r = await runPayroll([...events], [...employees]);
    expect(r.result.outcome).toBe("held");
    expect(r.mutation).not.toHaveBeenCalled();
    expect(r.ask).toHaveBeenCalledOnce();
    expect(r.ask).toHaveBeenCalledWith(expect.objectContaining({ to: "human_cfo", body: expect.stringMatching(reason) }));
    expect(r.decide).toHaveBeenCalledWith(expect.objectContaining({ outcome: "hold", amountCents: 123456 }));
  });

  it("accrues only valid employees and explains every withheld employee", async () => {
    const r = await runPayroll([snapshot([active, { ...active, id: "wrong-store", store: "store-2" }, { ...active, id: "inactive", status: "inactive" }])], [
      { id: active.id, name: active.name, grossCents: 10000 },
      { id: "unknown", name: "Unknown", grossCents: 20000 },
      { id: "wrong-store", name: "Wrong Store", grossCents: 30000 },
      { id: "inactive", name: "Inactive", grossCents: 40000 },
    ]);
    expect(r.result.outcome).toBe("held_partial");
    expect(r.mutation.mock.calls[0]![1].lines).toMatchObject([{ debit: 10000, credit: 0 }, { debit: 0, credit: 10000 }]);
    expect(r.decide).toHaveBeenCalledWith(expect.objectContaining({ outcome: "hold", amountCents: 90000 }));
    expect(r.ask).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringMatching(/Unknown.*\nWrong Store.*\nInactive/) }));
  });

  it("ignores future termination changes and future-effective snapshots", async () => {
    const future = { ...snapshot([{ ...active, status: "inactive" }], "2026-02-01"), occurredOn: "2026-01-02" };
    const r = await runPayroll([future, snapshot(), termination("2026-02-01")]);
    expect(r.result.outcome).toBe("posted");
    expect(r.ask).not.toHaveBeenCalled();
  });

  it("uses the latest eligible snapshot, even when supplied out of order", async () => {
    const r = await runPayroll([snapshot([{ ...active, store: "store-2" }], "2026-01-10"), snapshot(), snapshot([active], "2026-02-01")]);
    expect(r.result.outcome).toBe("held");
    expect(r.mutation).not.toHaveBeenCalled();
  });

  it("lets a newer active snapshot supersede an earlier termination", async () => {
    const r = await runPayroll([snapshot([active], "2026-01-10"), termination("2026-01-03"), snapshot()]);
    expect(r.result.outcome).toBe("posted");
    expect(r.ask).not.toHaveBeenCalled();
  });
});
