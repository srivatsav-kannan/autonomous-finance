import { journalDimensions } from "./gl-dimensions";
import type { Allocation, Candidate } from "./contracts";

export function sumCents(values: number[]): number {
  const result = values.reduce((sum, value) => sum + BigInt(value), 0n);
  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < 0n)
    throw new Error("Unsafe cumulative cents");
  return Number(result);
}
export function quantityMicros(decimal: string): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(decimal))
    throw new Error("Invalid exact quantity");
  const [whole, fraction = ""] = decimal.split(".");
  return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}
export function lineCents(decimal: string, unitCents: number): number {
  const result =
    (quantityMicros(decimal) * BigInt(unitCents) + 500_000n) / 1_000_000n;
  if (result > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Unsafe line cents");
  return Number(result);
}
export function accountingProblems(candidate: Candidate): string[] {
  const errors: string[] = [];
  try {
    for (const line of candidate.lines) {
      if (
        quantityMicros(line.quantity.decimal) <= 0n ||
        lineCents(line.quantity.decimal, line.unitPriceCents) !==
          line.amountCents
      )
        errors.push(`line_math:${line.lineId}`);
      if (
        sumCents(line.allocations.map((a) => a.amountCents)) !==
        sumCents([line.amountCents, line.taxCents])
      )
        errors.push(`allocation_sum:${line.lineId}`);
    }
    if (
      sumCents(candidate.lines.map((l) => l.amountCents)) !==
      candidate.subtotalCents
    )
      errors.push("subtotal_math");
    if (sumCents(candidate.lines.map((l) => l.taxCents)) !== candidate.taxCents)
      errors.push("tax_math");
    if (
      sumCents(candidate.freightAllocations.map((a) => a.amountCents)) !==
      candidate.freightCents
    )
      errors.push("freight_allocation");
    if (
      sumCents(candidate.discountAllocations.map((a) => a.amountCents)) !==
      candidate.discountCents
    )
      errors.push("discount_allocation");
    if (
      sumCents([
        candidate.subtotalCents,
        candidate.taxCents,
        candidate.freightCents,
      ]) -
        candidate.discountCents !==
        candidate.totalCents ||
      candidate.totalCents <= 0
    )
      errors.push("total_math");
  } catch {
    errors.push("unsafe_arithmetic");
  }
  return errors;
}
export type RecognitionLine = {
  account: string;
  debit: number;
  credit: number;
  dims?: { store?: string; department?: string; project?: string; vendor?: string };
  memo?: string;
};
/** First-wave reviewed allocations; discounts reverse their explicit cost allocation. */
export function recognitionLines(candidate: Candidate): RecognitionLine[] {
  const problems = accountingProblems(candidate);
  if (problems.length) throw new Error(problems.join(","));
  const allocations = (
    items: Allocation[],
    credit = false,
  ): RecognitionLine[] =>
    items
      .filter((a) => a.amountCents > 0)
      .map((a) => ({
        account: a.account,
        debit: credit ? 0 : a.amountCents,
        credit: credit ? a.amountCents : 0,
        dims: journalDimensions(a, candidate.supplierId),
        memo: `${a.treatment}; period ${a.period}`,
      }));
  return [
    ...candidate.lines.flatMap((l) => allocations(l.allocations)),
    ...allocations(candidate.freightAllocations),
    ...allocations(candidate.discountAllocations, true),
    {
      account: "2000",
      debit: 0,
      credit: candidate.totalCents,
      dims: { vendor: candidate.supplierId! },
    },
  ];
}
