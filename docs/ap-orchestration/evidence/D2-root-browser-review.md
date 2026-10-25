# Root browser review: physical identity, contact replacement and timing

Checked 25 October 2026 using CUA. The E03/E04 fixture uses the shared production components with explicitly synthetic records and no backend/provider actions. I2 timing uses the actual persisted local run with simulated humans and FakeBank. These are separate evidence scopes.

## Physical line identity

The exact original-to-parser map requires an explicit reviewed selection. Selecting the synthetic merged receipt and approved two-bin map leaves both physical quantity fields blank. For claimed quantity 1, entering 0.4 and 0.5 retains the exact-total error; changing the latter to 0.6 removes that error. This proves the local allocation check, not successful approval or backend reservation. Backend capacity and current authority were independently tested in V9.

The pending identity review starts with no decision, blank reason, unchecked comparison confirmation and disabled submission. In Period close, explicitly selecting receipt / merged-receipt / bin-a fills the frozen SKU, unit, parser row, source capacity and stated price; quantity to accrue and source quote remain blank. No proposal or decision was submitted.

Desktop layout was inspected at 1280 by 720. Mobile was measured at 390 by 844 with document width 390. Light and dark fixture palettes were checked. Mobile inspection found capacity hints flowing beside inputs and adjacent labels; production layout was corrected in 5b65ec4 and both mobile palettes rechecked. Fixed evidence: [light](D2-final-browser/e04-allocation-mobile-light-fixed.jpg), [dark](D2-final-browser/e04-allocation-mobile-dark-fixed.jpg). The desktop allocation screenshots precede that narrow layout correction.

## Trusted-contact replacement

Synthetic contact proposal and verification views were checked in both palettes. The old-channel-unavailable flow offers independent reestablishment, leaves date/reason/evidence/attestation blank and keeps final approval disabled before required verification/escalation. Desktop screenshots measured about 1164 pixels; the fresh mobile tab measured 390 pixels with no document overflow. The older tab ignored viewport override, so its screenshots are explicitly labeled desktop. No contact verification, escalation or replacement was submitted. End-stage CUA coverage remains separate from V8's independent backend/transport checks.

## Actual I2 timing

The persisted local run displays document-to-review 3m 8s, review-to-recognition 1m 38s, human queue median 17s and dispatched-payment outcome 116ms. The last value is FakeBank timing, not external bank latency. Never-dispatched proposals show not started, not zero-duration completion. Expanded timing basis shows the actual start/completion events, source revision/hash and event references. Desktop summary and 390-pixel mobile summary/basis were inspected; actual I2 dark palette was not claimed. See [readback](I2-operational-timing.md) and [mobile basis](D2-final-browser/i2-timing-basis-mobile.jpg).

No real identity approvals, QBO accounting transactions or Increase payments were performed by this browser review. All saved evidence is indexed with hashes in [manifest](D2-final-browser/manifest.json).
