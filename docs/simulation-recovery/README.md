# Simulator and payment recovery handoff

Status: **design and implementation TODO; runtime work has not started here**.

- Implementation issue: [#39](https://github.com/srivatsav-kannan/autonomous-finance/issues/39).
- All work selection, progress and acceptance tracking now belongs in issue #39.
  Preparation PR #40 is superseded; its branch and design files are retained.
- Parent architecture work: [#37](https://github.com/srivatsav-kannan/autonomous-finance/issues/37),
  with the broader design proposed in [PR #38](https://github.com/srivatsav-kannan/autonomous-finance/pull/38).
- Continuation branch: `codex/simulation-recovery-handoff`.
- Reviewed base: `9183d48c6921a1e1c08ea6c7fe011edad0ca56e9` on `main`.
- Goal: a credible end-to-end AP demo with low deployment and integration cost.

Start with [TODO.md](TODO.md), then read the [design and recovery policy](DESIGN.md).
The initial handoff commit contains documentation and diagrams only. It does not
implement a BankingProvider, FakeBank lifecycle, dispatcher, Increase adapter,
Prism suite or new runtime tests. Do not close #39 when only these documents merge.

The selected stack is Worldsim plus an independently persistent FakeBank for
repeatable tests, Increase sandbox for the first external AP integration, and
Prism for HTTP contract checks. Mockoon, stripe-mock, additional payment rails,
ERP/billing systems and an external ledger are deferred.

## Editable diagrams

Open the `.excalidraw` files in Excalidraw. The PNGs are checked-in previews and
must be regenerated and visually checked when the sources change. The diagrams
are proposals, not evidence that the current application implements their behavior.

- [Simulator and mock placement](diagrams/simulation.excalidraw)
- [Error handling and recovery](diagrams/recovery.excalidraw)

![Simulator and mock placement](diagrams/simulation.png)

![Error handling and recovery](diagrams/recovery.png)

## Prompt for the implementing agent

> Use issue #39 as the single work tracker. The preparation branch is
> `codex/simulation-recovery-handoff`; read
> `docs/simulation-recovery/TODO.md` and `DESIGN.md`. Inspect current main and the
> status of existing prerequisite issues/PRs; do not assume they are merged. Work
> through M0–M5 in dependency order, updating checkboxes only with code and test
> evidence. M1 can proceed independently while M0 is being resolved. Keep the real
> Convex approval, reservation, posting and reconciliation paths in recovery tests.
> Start with the BankingProvider contract and deterministic persistent FakeBank;
> then implement durable dispatch and verified ingestion before the Increase
> sandbox adapter and Prism checks. Preserve the same immutable command/key on
> ambiguous outcomes. Never re-send a bank payment to repair a local posting
> failure. Keep secrets and evaluator controls unavailable to agents. Report
> simulator, contract and sandbox results separately; missing credentials mean
> not run. Claim a workstream in issue #39 and create scoped implementation PRs
> linked to that issue; preparation PR #40 is superseded. Request srivatsav-kannan
> as reviewer. Do not merge or close #39 until the required implementation and
> acceptance evidence are complete.
