# E01 explicit tax header basis checkpoint

Scope: backend/contracts only, synthetic test policy. No policy activation, tax advice, practitioner signoff, external provider, HTTP or live-backend validation is claimed. Depends on integrated E01 + E02 at `8cd1923`.

The opt-in `recovery.headerBasis` declares freight inclusion, discount reduction/exclusion, and `half_up_taxable_base_proportion`. Every accepted line retains its original and accepted freight/discount amounts. Global sums must equal exact original and accepted headers; no inferred distribution. Header citations bind the current primary invoice and exact text spans. `TaxClaim.derivedHeaderBasis` freezes the treatment; it requires a printed net citation and forbids fake printed base/gross citations. Existing rate/stated-amount, date, eligibility, current independent tax stage and integer-cent controls remain.

Expected and exercised synthetic example: original net 7,700 + freight 1,000 − discount 200 = taxable basis 8,500; tax 850. Full recognition debits cost 8,500 and receivable 850, credits AP 9,350. Partial quantity 1 of 2 with explicitly accepted freight 100 and discount 50 yields cost 3,900, tax 390 and AP 4,290 (not a quantity-only 425 tax). This is a declared synthetic rule, not a claim of tax eligibility.

Linked credits carry explicit per-line freight/discount shares, retain their original frozen treatment, and must stay within cumulative original header and tax capacities. The exercised full-recognition example returns one unit with 100 freight/50 discount/390 tax, then one with 900 freight/150 discount/460 tax: net cost, receivable and AP all reach zero without cash or bank command. Changing the old policy does not recompute the original basis.

Validation: tax-header tests cover full/partial recognition, missing opt-in/shares, sum mismatch, stale source, fabricated printed basis, inflated basis, sequential credits, quantity-only tax mismatch, header overuse, historical missing attribution, explicit excluded headers and negative base. Combined `tax-header`, `tax-policy`, `tax-business`, `business-credits`, `cost-corrections`: 64 tests. Typechecks: application, backend and tests. Existing no-header routes remain compatible.

Unsupported: a packet with ambiguous/missing original header amounts/line attribution stays held; changing invoice face amounts or tax rate requires the existing source revision workflow. Tax eligibility reclassification is the separate next checkpoint, not an automatic result of header allocation. No tax filing, jurisdiction selection, foreign currency or real recoverability determination is implemented here.

UI seam: `acceptedLine.headerAllocation`, `acceptance.taxHeaderEvidence`, `tax.derivedHeaderBasis` + `facts.net`, and `credit.lines[].headerAllocation` are optional only for the old no-header route. Present-but-incomplete or unsupported combinations fail closed. Existing proposal/vote endpoints and additional independent tax stages apply unchanged.
