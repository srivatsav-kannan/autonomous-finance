# Actual I2 persisted operational durations

Read on25 October2026 from the existing I2 run after upgrading its isolated checkout to`e6b8fcf` and restarting only gateway8826. The backend remains3254/3255, UI5193 and run`ap97-b3-live-20261025`. This is real persisted local workflow data with explicitly simulated human seats and FakeBank, not actual human labor or external-provider latency. The gateway starts no worker.

The same revision1 case`k175gds0dypbgeknejs2henw5h8gysw8` produced these retained-event durations:

| Interval | Observed duration | Meaning |
| --- | --- | --- |
| Original revision retained → approved field review |188802ms|Begins after parsing; not upload/OCR latency|
| Approved field review → recognition posted |98846ms|Same revision and recognition journal|
| Business approval queue |93098ms|Elapsed queue time across the sequential simulated route|
| Actual10000-cent payment proposal → authorization |7301ms|Separate immutable payment snapshot|
| Actual payment dispatch claim → posted/matched outcome |116ms|FakeBank simulation only|

Both never-dispatched proposals correctly report unresolved-payment clock **not started**, with null elapsed time. No recovery interval is fabricated because this run has no retained completed failed-dispatch event. Overlapping queues are not added into a total. [Structured evidence](I2-operational-timing.json) retains the timestamps, references, current source hash and each frozen payment hash.

The complete case-list response was byte-for-byte identical before and after the GET metrics call. No bill, approval, journal, payment, worker or bank mutation was performed by this observation. Browser presentation is recorded separately after CUA verification.
