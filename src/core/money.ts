// Money is always integer cents. Floats never touch a balance.

export type Cents = number;

export function assertCents(value: unknown, label = "amount"): asserts value is Cents {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a safe integer number of cents, got ${String(value)}`);
  }
}

/** Parse "$1,234.56", "1234.56", "(12.00)" or "-12" into cents. Throws on anything ambiguous. */
export function parseMoney(text: string): Cents {
  const trimmed = text.trim();
  // "-12.00", "-$12.00", "$-12.00" and "(12.00)" are all negative.
  const negative = /^\(.*\)$/.test(trimmed) || /^\$?\s*-/.test(trimmed);
  const digits = trimmed.replace(/[()$,\s-]/g, "");
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(digits);
  if (!match) throw new Error(`not a money amount: ${JSON.stringify(text)}`);
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "0").padEnd(2, "0"));
  const cents = whole * 100 + fraction;
  assertCents(cents);
  return negative ? -cents : cents;
}

export function formatMoney(cents: Cents): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}

/** Multiply cents by a rate, rounding half away from zero (banker's rounding is not what invoices use). */
export function applyRate(cents: Cents, rate: number): Cents {
  const raw = cents * rate;
  return Math.sign(raw) * Math.round(Math.abs(raw));
}

export function sum(values: Cents[]): Cents {
  let total = 0;
  for (const v of values) total += v;
  assertCents(total, "sum");
  return total;
}
