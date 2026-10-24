# Invoice MVP evaluation preparation

No new application or live-model accuracy is available. The protocol was frozen in `357866ec73dd8a643408e4a3b1ca4db6654e99b7` before scores. Historical 18/18 baseline/pipeline results do not measure this MVP and the original fixture is already familiar.

Free preparation verified the exact upstream commit and original scorer, reset and extracted all 148 workspace files (112 PDFs), froze private held-out source/expectation hashes, and implemented the actual HTTP application adapter. Thirteen checks passed: ten adapter/source/artifact/mock HTTP checks and three tests of unmodified scorer behavior using synthetic grading rows. These are deterministic harness tests, not an application benchmark result.

The original scorer checks customer net amounts only, with an inclusive one-cent tolerance. Extra IDs do not reduce its accuracy; duplicate customer rows use the last value; missing negative totals produce signed error. Separate strict metrics check exact-cent count/gross/credit/net fields and duplicate/extra IDs. Document audits inspect recorded effects against private source expectations, while structural support checks separately verify immutable evidence references.

Original application, held-out application, live baseline, live application, restart, and assisted human/replay/stale-approval evaluation are **NOT RUN**. The live adapter refuses execution until spending is authorized and proper pre-request budget enforcement is available. No API calls or spend occurred. Required model credential: `ANTHROPIC_API_KEY`. Proposed one-time batch cap: $7.50; this is not authorization.

The original fixture has 100,094,614 source bytes. The largest JSON source is 1,218,637 bytes, requiring backend chunked original-byte storage and HTTP chunking. Root is coordinating that implementation. Further dependencies are a clean integrated runtime, fresh isolated company/run, runtime commit attestation, and actual process restart under root supervision. Missing usage remains unknown, not zero. No reviewer exists, so no second-role benefit can be claimed.

Commands and boundaries: [evaluation README](../../evals/invoice-mvp/README.md). Machine-readable status: [evaluation-results.json](evaluation-results.json). D remains goal-active for integrated acceptance.
