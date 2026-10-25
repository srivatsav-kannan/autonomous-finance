# I2 engineering integration checkpoint

Observed 2026-10-25 in the isolated Master worktree. This extends I1 without changing its settled obligation or bank history. No external transfer, QuickBooks grant or practitioner sign-off is claimed.

## Merged and verified

At `eb264f8`, 208 AP/business/auth/accounting tests passed across24 files, plus174 existing durable-payment tests across19 files. Application/backend/test TypeScript checks, console build and static design check passed. Build retains the existing large-main-chunk warning; design check has0 failures/0 warnings. V3 independent report on immutable6251f57 contributed19 adversarial tests and72 focused passes, all newly authored tests re-run afterB3 integration.

Root integration `d9ade7d` binds current B3 approvals/supplier destination at request, authorization and first dispatch. Four cross-layer tests verify another verified supplier (different from immutable legacy default), partial recognition3850 of original7700, partial scheduled cash2000, remaining1850, stale business approval denial at allthree boundaries, verified supplier change canceling only unsent work, unchanged recognition on recertification, and recovery of a possible original send after governance change without rewriting the request or key.

B3 return-capacity follow-up `8dce6f4` adds original-unit and retained-return-line limits plus governance reservation tests; its integration recheck is recorded separately. QBO partial recognition export uses the original approved allocation and journal rather than changing extracted invoice amounts.

## Live browser check and correction

Owned gateway8823 was restarted (exec35276), with existing backend3250 and UI5190 retained. Cold direct navigation to case`js7dsh0qwptbgg2ngm9vgbt6bs8gy13s` preserved bill`ks74ffsbn080a1wvxhtjks018h8gz3zv`, settled amount67860, outstanding0 and original recognition/settlement journals. The QuickBooks status endpoint shows private server configuration present, consent required, mappings missing, external writes disabled for Local FakeBank, and no successful external record receipt. Configuration presence is not evidence of valid credentials or an OAuth grant.

CUA inspection found a duplicate React key between Accounting and review-actions siblings after adding case-specific reset keys. Commit`8fac287` prefixes them independently. After cold reload and Matching→Accounting navigation, read-only DOM counts are exactly one accounting panel and one QuickBooks panel. The saved [actual-case screenshot](I2/accounting-status.png) displays the same settled bill and independent external-accounting state. This is not a synthetic UI fixture and does not prove an external sync.

## Remaining integration

D2 broader supplier/approval/credit/payment-run/close flows and responsive verification; B4 close/reconciliation; C4 partialcash/credit/return representation and private OAuth; independentB3/Auth0/newQBO review; real Auth0 human authorization, Increase settlement and practitioner review. These remain explicit tasks in the canonical registry.
