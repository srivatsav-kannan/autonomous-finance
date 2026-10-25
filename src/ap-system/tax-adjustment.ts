import type { TaxAdjustment } from "./tax-adjustment-contracts";
import { journalDimensions } from "./gl-dimensions";
/** A balanced noncash reclassification; no payable, settlement or source rewrite. */
export function taxAdjustmentJournal(
  action: TaxAdjustment,
  supplierId: string | null,
) {
  return action.movements.flatMap((m) => [
    {
      account: m.toAccount,
      debit: m.from.amountCents,
      credit: 0,
      dims: journalDimensions(m.from, supplierId),
    },
    {
      account: m.from.account,
      debit: 0,
      credit: m.from.amountCents,
      dims: journalDimensions(m.from, supplierId),
    },
  ]);
}
