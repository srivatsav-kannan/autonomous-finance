# Issue #97 — proposed AP screens

Six desktop UI concepts for [issue #97](https://github.com/srivatsav-kannan/autonomous-finance/issues/97), using the repository's warm white-and-green workbench design direction.

These are proposed screens with synthetic, illustrative states, not screenshots of implemented features or evidence of integration verification. They follow one Golden State Produce invoice, INV-1001, for USD 662.90 across successive workflow states. Day labels indicate sequence, not measured timing.

| Image | Proposed page | Behavior illustrated |
| --- | --- | --- |
| [01-work-queue.png](01-work-queue.png) | Work queue | A missing-receipt hold has an owner, required evidence, and next action; a renamed upload stays attached to the same case. |
| [02-source-review.png](02-source-review.png) | Source review | Original source, reviewed facts, and business evidence appear together. Unsupported source locations are explicit. Contract checking does not imply three-way matching. |
| [03-bill-approval.png](03-bill-approval.png) | Bill approval | Later receipt evidence permits review of the obligation and proposed recognition entry. Bill approval is distinct from payment authorization. |
| [04-payment-recovery.png](04-payment-recovery.png) | Payment recovery | An unknown bank outcome preserves the original operation and reservation. Replacement payment is unavailable; confirmed settlement may require accounting repair without resending. |
| [05-reconciliation.png](05-reconciliation.png) | Reconciliation | Bill, payment, bank, and journal are separately identified. Recognition and settlement differ. Bank-to-bill matching is distinct from AP-subledger-to-GL reconciliation. |
| [06-history-controls.png](06-history-controls.png) | History and controls | Each transition retains actor, reason, evidence revision, and before/after values. Connection verification and proposed policy precedents remain explicit. |

The four source-document product rows are placeholders. Synthetic supplier details, amounts, and sample account coding are design fixtures. The simulated payment/recovery sequence does not claim a real bank transaction. The proposed precedent panel is exploratory and inactive; policy authority remains separate from case review.

## Generation and review

Tool mode: built-in `image_gen` image generation and targeted image edits. Original prompts: [prompts.json](prompts.json). First corrections: [revision-prompts.json](revision-prompts.json). Final corrections: [final-corrections.json](final-corrections.json).

Reviewed all six raster images for visual readability, state consistency, source evidence, authority boundaries, and integration claims. An independent Hallmark finish review identified three issues; payment-recovery certainty, recorded-event markers, and a malformed navigation label were corrected. These are desktop raster concepts; no application code, responsive behavior, or implementation tests were produced by this design task.
