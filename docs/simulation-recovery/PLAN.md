# AP demo

One invoice → approval → payment → reconciliation. It must survive a worker
restart without paying twice.

Keep Convex for the app state and journal, and the existing Node worker.
Use Worldsim for invoices, a persistent FakeBank for repeatable failures, and
Increase sandbox to check the real API. Defer ERP and external-ledger integrations.

![System](diagrams/system.png)

## Build

- [ ] **A — Fake bank.** Define the shared bank interface. Persist transfers and
  transactions independently of the worker. Same key and payload must return the
  same transfer; a changed payload must fail. Add an accept-then-drop-response fault.
- [ ] **B — Safe dispatch.** Fix the selected flow's approval and credit bugs.
  Bind approval to exact payment details. Reserve funds and save the command/key
  atomically. Persist attempts; a replacement worker must fence out the old one.
  Unknown outcomes keep their reservations. Cancellation must not race a send.
- [ ] **C — Reconcile.** Fetch bank evidence after a webhook or poll. Deduplicate
  it and post once. Retry failed local writes without sending another payment.
  Returns get a separate entry. Show unresolved payments in the console.
- [ ] **D — Sandbox demo.** Implement the Increase adapter behind the same
  interface. Run the flow end to end and record the provider transaction and
  journal entry. Add request/response contract checks to the adapter tests.

A and B can start together after agreeing the interface. C uses their saved
command and bank IDs. D can prepare fixtures early; run payments after B and C work.

![Recovery](diagrams/recovery-flow.png)

## Prove it

1. Approve and pay an invoice. Match one bank debit to one journal entry.
2. Lose the bank response, restart the worker, and drop the webhook. Polling must
   recover the same transfer. No duplicate payment or cash posting.
3. Reject changed payment details without fresh approval. Duplicate events and
   returns must leave correct balances; unresolved outcomes block a clean close.

Existing bugs and edge cases: [detailed checklist](TODO.md).
Schema/accounting details: [contract](IMPLEMENTATION_CONTRACT.md).
Older drawings: [reference gallery](DIAGRAMS.md).

Track ownership and results in [issue #39](https://github.com/srivatsav-kannan/autonomous-finance/issues/39).
This is the build plan; the runtime work is still outstanding.
