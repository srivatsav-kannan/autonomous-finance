# Claude 独立模型评审 — external handoff

Status: **packet ready; external Claude review not yet executed**. The user confirmed that the recipient has Claude and will perform the review. Local Claude login is not a delivery prerequisite. No finding-free result, completed repair, model acceptance or practitioner sign-off is claimed.

On 2026-10-25 the user replaced the unavailable AP practitioner review for this delivery with **Claude 独立模型评审**. A human AP practitioner is no longer a delivery blocker. Claude must first derive expected results independently from originals/policy, then compare the implementation evidence and retain findings, fixes and re-review. Actual operator bill/payment decisions and QuickBooks/Increase sandbox tests remain separate and unchanged. CI is explicitly deferred by the user's later instruction; its known failure is preserved, not relabeled passed. USD-only and laptop/desktop scope remain in force.

## Recipient procedure

1. Start a fresh Claude conversation with only [phase1 blind input](claude-review/01-blind-input/START-HERE.md). Paste its PROMPT.txt, attach the policy/events and all five original PDFs. Use no repository/project context that exposes implementation results. Record the actual displayed model and exact uploaded files.
2. Obtain the full case-by-case independent derivation, including missing evidence and conditional alternatives. Save the complete unedited answer, compute its SHA-256 and freeze it with a timestamp **before** revealing phase2.
3. In the same conversation, upload [phase2 actual evidence](claude-review/02-comparison/EVIDENCE-MAP.md) and paste its PROMPT.txt. Ask for source-based comparisons, errors and evidence gaps. Existing test summaries and the team answer key cannot establish actual behavior.
4. Return both complete Claude answers plus the filled [review record](claude-review/03-review-records/RECORD-TEMPLATE.md), exact model, timestamps, manifest hashes and stable finding IDs. Preserve failed reviews and original wording. The implementation owner fixes accepted defects and attaches exact commits/new evidence; the recipient uses Claude to re-review every finding separately.

The two phase directories have individual SHA-256 manifests. Keep phase2 unavailable until the phase1 response is frozen. Zip copies are produced separately for transport; the handoff zip intentionally contains both and is for the operator, never a blind reviewer upload.

## Coverage and limitations to preserve

The package contains five original synthetic Golden State PDFs, extracted transcripts, a compiled declared company policy, 22 scenario families plus I3, actual retained I1/I2/I2-close/I3 business/journal readbacks, and append-only review templates. Actual snapshots are linked to their original runtime revisions, not presented as a fresh latest-head run. Phase2's expected-posting answer key is clearly marked EXPECTED_ONLY.

The original packet lacked component originals/actual exports. The separately hashed [component supplement](claude-review/04-component-supplement/README.md) now adds31 actual local scenarios across C02/C04-C22,74 database journal rows,57 distinct synthetic text originals plus4 original PDFs and12 policy payloads. Reveal its source/policy directory before its results and preserve a separate frozen derivation if the first review already began. These are bounded component variants, not every alternative or real supplier evidence. C19/C22 include14 explicitly flagged source/chunk scope mismatches from protocol-fixture promotion; byte hashes are verified but scoped source API access is not. C02 now includes an original-PDF quantity-conflict database snapshot and no-transfer bank trace; candidate facts are manually constructed, not a fresh parser run. None of these records is a Claude finding or a model acceptance result.

Credential files, JWTs, live identity details and raw parser caches with signed URLs are excluded. All supplied supplier documents are synthetic. No live economic action is performed by preparing/reviewing this package.

## Current acceptance record

- Model review: awaiting external Claude operator; [status](claude-review/03-review-records/status.json).
- Practitioner review: not required for this delivery; never claimed completed. Prior practitioner packet/expectations are historical preparatory material.
- CI: deferred by user. PR105 run40187986581 retains regression failure; browser/recovery jobs passed. No CI fix or rerun is part of this handoff.
- External QBO/Increase: one synthetic USD invoice/payment round trip and local funding reconciliation passed; broader external lifecycle tests remain separate. See the subsequent live-sandbox supplement below.
- [Full manifest](claude-review/MANIFEST.json) links immutable bytes to the handoff.

Supplement validation:31 selected existing scenarios passed;74 journal rows exactly match captured databases and balance in integer cents. Source lengths/hashes, archives and separate phase manifests were checked. No product code/test assertion or CI change was made. The initial handoff archives/manifests remain immutable.

## Subsequent live-sandbox comparison addendum (25 October 2026)

After freezing the independent phase1 derivation, include [the actual invoice/payment/QBO round trip](evidence/C4-live-happy-path.md) and [the completed funding reconciliation](evidence/C4-funding-reconciliation.md), with their structured records. These are additional implementation outcomes for comparison, not Claude findings. The original review archives/manifests are unchanged. The funding fact is an official simulated inbound ACH +USD678.60; the user authorized test-capital classification. Expected policy treatment is explicitly synthetic contributed capital. Require Claude to assess journal arithmetic, exact bank links, duplicates and the stated limits, including no formal month close and no QBO export of the test-capital journal.

The separately hashed [live comparison supplement](claude-live-supplement/README.md) packages these actual records and scope limits. Share it only after the corresponding independent source/policy derivation is frozen. This supplement does not alter the original blind/comparison archives.
