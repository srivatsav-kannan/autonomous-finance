import type { Doc } from "../../convex/_generated/dataModel";

export type AskEffect = NonNullable<Doc<"asks">["effect"]>;

const money = (cents: number) => "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * What the buttons do, from the kernel's stored effect. Titles, bodies and option labels are
 * written by agents; this summary is not, so it is what the human should check before clicking.
 */
export function AskEffectSummary({ effect }: { effect?: AskEffect }) {
  if (!effect) return <p className="effect-summary none">Answering only records your response. It approves, merges and signs nothing.</p>;
  const rows: [string, string][] = effect.kind === "payment"
    ? [["Pays", effect.payee], ["Amount", money(effect.amountCents)], ["Remit to", `${effect.remitTo.bank} ****${effect.remitTo.accountLast4}`], ["Method", `${effect.method.toUpperCase()}, due ${effect.dueDate}`]]
    : effect.kind === "merge"
      ? [["Merges", effect.proposalBranch], ["Changes", effect.paths.join(", ")], ["At commit", effect.headSha.slice(0, 8)]]
      : [["Co-signs close", effect.period]];
  const what = effect.kind === "payment" ? "Approving releases this payment as you" : effect.kind === "merge" ? "Merging changes company memory as you" : "Signing closes this period as you";
  return <section className="effect-summary" aria-label="What this decision does">
    <p>{what}:</p>
    <dl>{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
  </section>;
}
