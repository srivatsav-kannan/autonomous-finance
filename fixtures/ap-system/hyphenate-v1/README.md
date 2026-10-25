# Hyphenate work fixture

`work-packet.json` is an authored synthetic USD $77 invoice, purchase order, contract and receipt. It reuses the four original PDFs retained in `docs/ap-orchestration/evidence/agent-live-20261025/sources/` and their cached extraction. SHA-256 values bind the retained original bytes. It contains no provider credentials, real customer history or new parser result.

The isolated demo helper withholds the receipt for revision 1 and supplies it on revision 2 of the same case. It uses a new FakeBank/local run; it never replays the old Increase transfer. Supplier master evidence and independent simulated governance are explicitly authored by the helper.

The distinct A/B/C coding experiment is defined in `src/ap-system/precedent-contracts.ts` and `convex/apPrecedents.ts`. Its historical outcome is supplied synthetic evidence, not an observed human correction in the new AP case. B/C are demo checks, not a blinded benchmark.
