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

C04-C22 do not have independently supplied supplier originals and complete actual journal exports in this handoff. Claude can challenge their declared policy/arithmetic and request evidence, but must not mark implementation behavior verified merely from the answer key or earlier tests. C02 has its discrepancy original but lacks a separate raw execution readback here. These are explicit packet coverage gaps for the recipient, not fabricated Claude findings or silently passed cases.

Credential files, JWTs, live identity details and raw parser caches with signed URLs are excluded. All supplied supplier documents are synthetic. No live economic action is performed by preparing/reviewing this package.

## Current acceptance record

- Model review: awaiting external Claude operator; [status](claude-review/03-review-records/status.json).
- Practitioner review: not required for this delivery; never claimed completed. Prior practitioner packet/expectations are historical preparatory material.
- CI: deferred by user. PR105 run40187986581 retains regression failure; browser/recovery jobs passed. No CI fix or rerun is part of this handoff.
- External QBO/Increase: required under prior plan; current reference/auth evidence does not replace accounting transaction or payment acceptance.
- [Full manifest](claude-review/MANIFEST.json) links immutable bytes to the handoff.
