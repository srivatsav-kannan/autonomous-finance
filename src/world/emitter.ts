import { AdminClient, api } from "../core/kernel-client";
import type { WorldBank } from "./bank";
import { Rng } from "./rng";
import type { Scenario } from "./scenario";

/**
 * Push one sim day of the outside world into the company: documents, bank feed lines,
 * POS exports, payout reports, payroll registers, plus yesterday's payment debits.
 * Every event carries an external id, so re-sending a day is harmless (exactly-once ingest).
 */
export async function emitDay(sc: Scenario, date: string, admin = new AdminClient(), opts: { duplicateRate?: number; legacyBankFeed?: Pick<WorldBank, "debitsFor"> } = {}) {
  const random = new Rng(sc.options.seed ^ Number(date.replaceAll("-", "")));
  const todays = sc.events.filter((e) => e.occurredOn === date);
  const debits = (opts.legacyBankFeed?.debitsFor(date) ?? []).map((p) => ({
    type: "bank.transaction",
    externalId: `opr-${p.bankRef}`,
    occurredOn: date,
    payload: {
      account: "operating",
      txnId: `opr-${p.bankRef}`,
      date,
      amountCents: -p.amountCents,
      description: `ACH CREDIT TRANSFER ${p.payee.toUpperCase()} ${p.bankRef}`,
      bankRef: p.bankRef,
    },
  }));
  // day.end goes last so the payments run sees the whole day.
  const ordered = [...debits, ...todays.filter((e) => e.type !== "day.end"), ...todays.filter((e) => e.type === "day.end")];
  await admin.client.mutation(api.admin.setSimDate, { secret: admin.secret, runId: sc.runId, simDate: date });
  let ingested = 0;
  let duplicates = 0;
  for (const e of ordered) {
    const sends = opts.duplicateRate && random.next() < opts.duplicateRate ? 2 : 1;
    for (let i = 0; i < sends; i++) {
      const r = await admin.client.mutation(api.admin.ingestEvent, {
        secret: admin.secret,
        runId: sc.runId,
        type: e.type,
        externalId: e.externalId,
        occurredOn: e.occurredOn,
        payload: e.payload,
      });
      if (!r.ok) throw new Error(`ingest failed: ${r.code} ${r.error}`);
      if (r.duplicate) duplicates++;
      else ingested++;
    }
  }
  return { date, ingested, duplicates };
}

export function scenarioDays(sc: Scenario): string[] {
  return [...new Set(sc.events.map((e) => e.occurredOn))].sort();
}
