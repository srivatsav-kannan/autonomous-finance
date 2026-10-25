/** Exact decimal arithmetic. No floating-point rounding, OCR repair or locale guessing. */
export function signedDecimalCents(raw: string): number | undefined {
  let value = raw.trim().replace(/\u00a0/g, " ").replace(/\u2212/g, "-");
  if (value.length > 128) return undefined;
  const parentheses = value.startsWith("(") && value.endsWith(")");
  if (parentheses) value = value.slice(1, -1).trim();
  const match = /^(-)?\s*(?:(?:USD|US\$|\$)\s*)?(-)?((?:\d{1,3}(?:,\d{3})+|\d+))(?:\.(\d{1,2}))?(?:\s+USD)?$/i.exec(value);
  if (!match || Number(Boolean(match[1])) + Number(Boolean(match[2])) + Number(parentheses) > 1) return undefined;
  const cents = BigInt(match[3]!.replaceAll(",", "")) * 100n + BigInt((match[4] ?? "").padEnd(2, "0"));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return Number(cents) * (parentheses || match[1] || match[2] ? -1 : 1);
}

export function decimalCents(value: string): number | undefined {
  // Routine input remains positive and unsigned; credits normalize signs explicitly elsewhere.
  if (/[-()\u2212]/.test(value)) return undefined;
  const cents = signedDecimalCents(value);
  return cents !== undefined && cents > 0 ? cents : undefined;
}
