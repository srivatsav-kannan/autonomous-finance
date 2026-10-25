# Implementation evidence revealed only after phase 1

| Cases | Retained actual evidence | Limits |
| --- | --- | --- |
| C01 | observed/I1-retained-readback.json: source hashes, case/run, line-level recognition and bank-linked settlement journals, replay counts | Older local runtime a13b131; simulated human and FakeBank. Not latest-head re-execution. |
| C02 | No separate raw execution readback included in this handoff | Original discrepancy PDF is included in phase1; team answer key is only a claim. Request execution record to conclude implementation correctness. |
| C03 | observed/I2-retained-readback.json plus I2-close-retained-readback.json: accepted/disputed/cash amounts, journals, distinct votes, future-date and replay observations, actual close blockers | Older run revisions are retained; simulated principals; some dimension detail/source attestations may require fuller records. |
| I3 | observed/I3-retained-readback.json: exact source and harness hashes, phase timestamps, command/bank/journal lineage, crash and original lookup, polling and counts | Local genuine process kill, cached genuine parser artifacts and FakeBank; no real operator/payment/provider acceptance. |
| C04-C22 | TEAM-EXPECTED-ONLY.json is an implementation-team expected answer set; it is not actual execution evidence | These component scenarios need their exact original bytes, configured policy/decisions and actual journal/state exports before their implementation behavior can be independently signed off. Prior test summaries are intentionally not used to fill this gap. |

The raw signed parser cache, live credentials, OAuth tokens, JWTs and real identity details are excluded. Original PDF bytes were copied without modification and transcripts extracted with Poppler. The included structured run files are byte-identical to retained repository evidence; some historical wording about practitioner review or then-unconnected QBO is historical and is superseded for current acceptance by the handoff scope.

Current external status: real Auth0 login and scoped binding verified; QBO OAuth plus eight reference mappings read back and replayed with zero new records; no QBO accounting transaction round trip yet. Increase source/destination read verified; no actual user payment authorization, funding or transfer yet. External tests stay required under the unchanged plan. Neither a Claude conclusion nor this handoff authorizes payment.

CI scope: the user explicitly deferred CI. Run40187986581 at PR105 head11244ee failed regression (37 failures beginning with macOS-specific /private/tmp setup;1849 passed;4 skipped). Browser and isolated recovery jobs passed. No CI fix/rerun is included in this handoff. The earlier local full suite at its recorded revision passed1886 with4 skips. Those results are distinct and neither is an accounting review answer.
