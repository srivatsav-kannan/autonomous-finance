# Golden State packet v1

All companies, transactions and people in this packet are synthetic. This is an original-file engineering fixture, not a real supplier invoice or actual Sweetgreen books. The input PDFs were rendered from frozen simulator facts before any LlamaParse result was requested.

`input/` is runtime source material. `evaluation/` is evaluator-only and must never be mounted in, served by or read by the ingestion runtime. The manifest describes this boundary; runtime adapters do not import the fixture or its expected outcomes.

The clean invoice is INV-1001 dated 2026-10-19, USD 678.60, Net 14, due 2026-11-02. The exported `receiving.logged` and `document.received` events come from `generateWorld({seed:97,storeCount:1,start:'2026-10-19',days:1,plantErrors:false})`. Quantities are 5 KALE-24, 4 ROM-CS, 3 AVO-48 and 2 TOM-25. The supplier profile supplies the four prices and declared case units. The PO and contract are explicitly authored synthetic supporting documents, not records claimed to exist in the original simulator.

`invoice-quantity-discrepancy.pdf` is an independent test variant INV-1001-QTY: six kale cases are invoiced while the frozen receipt still records five. Its USD 717.10 total preserves the supplier claim; the policy outcome is a hold, never automatic short-pay. A missing-receipt variant is the clean packet without receipt evidence. Duplicate testing uses a renamed byte-identical invoice; unrelated same-name documents must remain distinct.

Reproduce from the source revision in facts.json, Node >=24.18 and Python with ReportLab 4.4.9:

```sh
AP_PYTHON=/path/to/python node --import tsx scripts/ap-system/export-golden-state.ts
```

The exporter uses ReportLab's invariant mode; a second export to another directory yields identical PDF hashes. It does not deploy or seed a backend. Optional second argument selects an isolated output directory. PDF visual checks and policy-derived outcomes are engineering evidence only. Independent agent review and AP practitioner review remain separate gates.
