# Spreadsheet tools vs the agent-native kernel (part A: deterministic benchmark)

Generated 2026-10-25T04:07:07.356Z by `npm run eval:sheets-bench -- --seed 7 --stores 3 --days 14 --trials 10 --warmup 2` at commit `d8ba4676779f`. No model is involved; every number below was measured on this run.

## Headline

| | Kernel (typed calls) | Spreadsheet, saved each op | Spreadsheet, in memory |
|---|---|---|---|
| Median time per operation | 0.12 ms | 7.67 ms (66x) | 1.12 ms (9.7x) |
| p95 time per operation | 0.16 ms | 13.5 ms | 2.23 ms |
| Median per operation, first tenth -> last tenth of the stream | 0.12 -> 0.12 ms | 2.62 -> 13.3 ms | 0.20 -> 2.23 ms |
| All 156 operations, median per trial | 18.7 ms | 1216 ms | 180 ms |
| Tool calls per operation | 1 | 5.78 | 5.78 |
| Tool calls for the whole stream | 156 | 902 (+132 to import the bank feed) | same |
| Bad operations stopped before they landed (of 18) | 16 | 0 | 0 |
| Bad operations flagged after landing | 2 (hash chain) | 8 (reconciliation checks) | same |
| Bad operations nobody noticed | 0 | 10 | same |

Both paths produced identical books from the clean stream before any bad operation was injected:
trial balance equal on all 31 accounts, the same bills in the same statuses, 152 journal entries vs 599 ledger rows, and every workbook check at 0.

## How to read it

- **Tool calls are the main pace cost.** The spreadsheet path needs 5.78 tool calls per operation where the kernel needs 1. For an agent each tool call is a model round trip or at least a network round trip, so this ratio, not the in-process milliseconds, is what drives wall time and tokens. Part B measures that with a model.
- **Compute alone is a smaller gap.** With the workbook held in memory (no saves), a spreadsheet operation takes 1.12 ms median against 0.12 ms for the kernel, because recalculating SUMIFS over the whole ledger grows with the books (0.20 ms early, 2.23 ms late).
- **Saving dominates the saved column.** An .xlsx file is rewritten whole on every save, so the cost grows with the workbook (2.62 ms early, 13.3 ms late; final file 42 KB). The kernel figure includes no durable commit at all, because a live Convex deployment was out of scope, so the saved-vs-kernel ratio overstates the gap a deployed kernel would show; treat the in-memory column as the like-for-like compute comparison.
- **Reliability is the larger difference.** The kernel stopped 16 of 18 bad operations before they touched the books and caught the other 2 (direct edits) by hash chain. The workbook accepted all 18; its reconciliation checks flagged 8 afterwards, and 10 left no trace.

## What was measured

- **World:** seed 7, 3 stores, 14 days from 2026-01-01: 230 events, 156 bookkeeping operations (64 record_bill, 3 resolve_bill, 45 post_entry, 44 match_bank).
- **Kernel path:** each operation is one call to the real mutation handlers (`convex/ap.ts` recordBill and resolveHeldBill, `convex/ledger.ts` postEntry), run in process against `tests/helpers/kernelHarness.ts`. Seat auth, idempotency, capability checks, double entry, evidence checks and the hash chain all run. World events enter through the real `admin.ingestEvent`.
- **Spreadsheet path:** a real .xlsx workbook (exceljs 4.4.0) with Ledger, AP, Bank, TB and Checks sheets. TB uses SUMIFS over the ledger; Checks holds the reconciliations a finance team builds (TB difference, duplicate vendor + invoice flag, two bank recs, AP subledger vs GL). Each operation uses only `read_range`, `write_range`, `find_rows` and `recalc` (recalculate every formula and save the file). The careful procedure looks up duplicates or the bank line, finds the next free row, writes the rows, recalculates and saves, then reads Checks back.
- **Same input:** both paths apply one pre-built stream. Invoice text is extracted once before timing and is not part of either path's time.
- **Trials:** 10 measured trials after 2 warm-up, path order rotated each trial. Per-operation figures pool every operation across trials (nearest-rank median and p95). Total benchmark wall time 23.5 s.
- **Machine:** Apple M5 Pro, 18 logical cores, 24 GB, Darwin 25.6.0 arm64, Node v26.5.0.

## Time per operation (ms)

| Operation | Kernel median / p95 | Spreadsheet saved median / p95 | Spreadsheet in memory median / p95 |
|---|---|---|---|
| Record a vendor bill | 0.12 / 0.16 | 7.39 / 13.5 | 1.06 / 2.23 |
| Controller resolves a held bill | 0.13 / 0.19 | 2.13 / 3.95 | 0.13 / 0.18 |
| Post a journal entry (sales, payroll) | 0.12 / 0.15 | 8.18 / 13.5 | 1.20 / 2.27 |
| Match a bank transaction | 0.11 / 0.14 | 8.08 / 13.0 | 1.18 / 2.02 |

Spreadsheet tool calls, saved variant (ms per call):

| Tool | Calls | Median | p95 |
|---|---|---|---|
| find_rows | 1110 | 0.01 | 0.02 |
| read_range | 4160 | 0.00 | 0.01 |
| write_range | 3070 | 0.01 | 0.03 |
| recalc | 2000 | 7.67 | 13.3 |

## Tool calls per operation

| Operation | Kernel calls | Spreadsheet calls | Cells read | Cells written |
|---|---|---|---|---|
| Record a vendor bill | 1 | 6.88 | 15 | 31.88 |
| Controller resolves a held bill | 1 | 6 | 30 | 24 |
| Post a journal entry (sales, payroll) | 1 | 4 | 15 | 68.4 |
| Match a bank transaction | 1 | 6 | 21 | 27.8 |

A spreadsheet call that only finds the next free row is counted. An `append` tool would remove one or two calls per operation; the check read-back is the only thing that lets the spreadsheet agent notice it broke the books, so dropping it would also drop the spreadsheet's detections below.

## Injected bad operations

Each case starts from a fresh copy of the clean books. Kernel: *prevented* means the call was refused and no entry, bill or balance changed; *absorbed* means an idempotent replay returned the original result; *detected* means `verifyChain` found the edit. Spreadsheet: every write lands; *detected* means at least one Checks cell became non-zero afterwards.

| Case | Invariant | Kernel | Spreadsheet |
|---|---|---|---|
| journal entry whose debits ($100.00) exceed credits ($90.00) | double entry | prevented: invalid_entry: entry does not balance: debits 10000 != credits 9000 | detected: Trial balance difference (debits - credits) = 1000 |
| balanced entry to account 9999, which is not in the chart | chart of accounts | prevented: invalid_entry: line 0: unknown account 9999 | detected: Trial balance difference (debits - credits) = -5000 |
| balanced entry for 1,000.5 cents | integer cents | prevented: invalid_entry: line 0: amounts must be integer cents | **missed** |
| balanced entry dated 2025-12-31, a closed period | closed periods are locked | prevented: period_closed: period 2025-12 is closed; post a correction in an open period | **missed** |
| re-record golden-state-produce INV-1001 from a second received copy | duplicate invoice | prevented: duplicate_invoice: golden-state-produce invoice INV-1001 duplicates a bill already recorded (approved) | detected: AP rows sharing vendor + invoice number = 2 |
| re-record the same invoice typed as "inv 1001" | duplicate invoice | prevented: duplicate_invoice: golden-state-produce invoice inv 1001 duplicates a bill already recorded (approved) | **missed** |
| bill line 3 x $10.00 recorded as $35.00 | bill arithmetic | prevented: invalid_bill: line 0: 3 x 1000 != 3500 | **missed** |
| approved bill citing a document that was never received | evidence | prevented: no_document: document doc-never-received was never received | **missed** |
| AP clerk approves a $12,000 bill (limit $5,000) | approval limits | prevented: over_limit: ap_clerk may auto-approve up to 500000 cents; hold for the controller | **missed** |
| approve a bill that carries an open price-over-contract exception | approval policy | prevented: policy: a bill with open exceptions cannot be approved; hold it | **missed** |
| the controller records a held $800 bill, then approves it itself | segregation of duties | prevented: sod: the seat that recorded a bill cannot resolve it | **missed** |
| AP clerk pays a vendor off-book: Dr 2000 / Cr 1000 cash, $500 | capabilities / cash needs bank evidence | prevented: no_bank_evidence: cash entries must be bank matches citing a bank transaction | detected: Bank rec, operating 1000 (books - bank) = -50000; AP subledger (approved) vs GL 2000 = 50000 |
| deposit booked against a bank transaction that does not exist | cash needs bank evidence | prevented: no_bank_evidence: no bank transaction dep-never-happened | detected: Bank rec, deposits 1020 (books - bank) = 20000 |
| a $500.00 deposit booked as $510.00 | cash equals the bank | prevented: evidence_mismatch: bank transaction dep-bench-mismatch is 50000 cents but the entry moves 51000 | detected: Bank rec, deposits 1020 (books - bank) = 1000 |
| book dep-sf-hayes-valley-2026-01-01 a second time | one bank line, one entry | prevented: already_matched: bank transaction dep-sf-hayes-valley-2026-01-01 is already booked | detected: Bank rec, deposits 1020 (books - bank) = 681393 |
| a retry re-sends an already-applied sales posting (same idempotency key) | exactly once | absorbed: idempotent replay returned the original result; nothing posted twice | **missed** |
| edit a posted daily-sales entry: +$1,000 on both the 1100 debit and the 4000 credit | tamper evidence | detected: verifyChain: broken at entry #4 | **missed** |
| edit a posted bill accrual: +$1,000 on both the expense debit and the 2000 credit | tamper evidence | detected: verifyChain: broken at entry #1 | detected: AP subledger (approved) vs GL 2000 = -100000 |

## Limits of this measurement

- **No durable commit on the kernel side.** The DB double keeps everything in memory. The saved spreadsheet variant pays for a durable file write on every operation; the kernel variant pays for none.
- **Both paths run in process.** The kernel runs against an in-memory DB double, not a Convex deployment, and the workbook is a local file. A deployed kernel adds one network round trip per operation; a hosted spreadsheet API (Microsoft Graph, Google Sheets) adds one per tool call, so the tool-call ratio above is the better guide to hosted latency than these milliseconds.
- **The DB double is not tuned.** It scans whole tables instead of using indexes and deep-copies rows, which works against the kernel.
- **The spreadsheet evaluator is ours.** exceljs has no calculation engine. Our evaluator handles only the formulas in this workbook and evaluates each cell at most once per recalc, so it is probably faster than a general engine; that favors the spreadsheet.
- **Amounts are integer cents in both paths.** A real workbook usually holds dollars as floating point; we avoided that so rounding would not cause false alarms. That also favors the spreadsheet.
- **The spreadsheet gets generous checks.** Many real workbooks have none of the five reconciliations. Segregation of duties, approval limits, closed periods and evidence are not checked, because a workbook cannot tell who typed a cell.
- **Bookkeeping only.** The stream records what a correct agent would book. Judgment errors (price over contract, short shipments, ghost employees) are agent decisions, not substrate invariants; they are what part B and `npm run eval` measure.
- **One machine, one seed.** Absolute milliseconds will differ elsewhere; ratios and call counts should not move much.
