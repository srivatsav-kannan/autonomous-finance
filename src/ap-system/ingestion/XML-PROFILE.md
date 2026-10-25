# Project UBL 2.1 invoice profile v1

The direct structured route accepts `application/xml`, `text/xml` and `application/ubl+xml`. It does not send XML to LlamaParse or an LLM. The public parseUpload/combineUploads API is unchanged. Python's standard-library Expat parser is invoked through `AP_PYTHON` (default `python3`), with a five-second subprocess deadline. No additional package is required.

Identifiers are mandatory and exact:

| Item | Accepted value |
| --- | --- |
| Root | `{urn:oasis:names:specification:ubl:schema:xsd:Invoice-2}Invoice` |
| Aggregate namespace | `urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2` |
| Basic namespace | `urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2` |
| UBLVersionID | `2.1` |
| CustomizationID | `urn:autonomous-finance:ap:ubl-2.1:invoice:v1` |
| ProfileID | `urn:autonomous-finance:ap:invoice:usd-explicit-tax:v1` |
| InvoiceTypeCode | `380` |
| DocumentCurrencyCode and amount currencyID | `USD` |

Producer namespace prefixes may differ; expanded names are authoritative. Unknown versions/profiles, spoofed namespaces, duplicates and missing fields cannot become a complete candidate. This is a project-owned strict structural subset, not a general OASIS XSD validator or Peppol conformance implementation. The OASIS [UBL 2.1 standard](https://docs.oasis-open.org/ubl/os-UBL-2.1/UBL-2.1.html) defines the namespaces and Invoice document; its [Invoice model](https://docs.oasis-open.org/ubl/os-UBL-2.1/mod/summary/reports/UBL-Invoice-2.1.html) supplies the element meanings used here. No schema is fetched at runtime.

Accepted structure follows the listed UBL order. Every scalar is unique and nonempty. Header: the identifiers above; invoice ID; IssueDate; optional DueDate; supplier Party/PartyLegalEntity/RegistrationName; customer Party/PartyName/Name; optional PaymentTerms/Note; one TaxTotal containing only TaxAmount; one LegalMonetaryTotal; and 1–200 InvoiceLine elements. The monetary total requires LineExtensionAmount, TaxExclusiveAmount, TaxInclusiveAmount, AllowanceTotalAmount, ChargeTotalAmount and PayableAmount. Current profile requires allowances and charges to be explicitly zero.

Each line requires a unique source ID, positive InvoicedQuantity with unitCode, LineExtensionAmount, a TaxTotal containing explicit TaxAmount, Item with Description and SellersItemIdentification/ID, and Price with PriceAmount and BaseQuantity. BaseQuantity must be exactly `1` with the same unitCode. The adapter retains the original unitCode; supplier policy must explicitly recognize it before business acceptance. Missing or unsupported tax breakdowns hold; the adapter never invents rates, jurisdiction or exemptions.

Money uses unsigned decimal syntax with at most two fractional digits and safe integer cents; quantity supports up to six decimal places. BigInt arithmetic verifies each line's quantity × unit price equals its printed amount with no rounding. Line amounts sum to document LineExtensionAmount and TaxExclusiveAmount. Explicit line taxes sum to document TaxAmount. TaxInclusiveAmount and PayableAmount must both equal subtotal + stated tax. Positive tax maps to line.taxCents; trusted coding allocations cover amount + tax. Tax subtotals, charges/allowances, credits, prepayments, rounding, alternative tax currencies, attachments, extensions, signatures and other elements/attributes are unsupported and produce an incomplete result. This refusal is a profile limitation, not a claim that such UBL documents are invalid.

Supplier binding compares the extracted registration name with the trusted legal name/allowed aliases after NFC, whitespace and case normalization. XML entity references are decoded once by the syntax parser; HTML markup is not stripped or decoded again. Unmatched names retain their actual extracted value and supplierId null. Printed customer/supplier text never conveys approval authority.

Every retained field uses `native` + `xml_path` and an absolute path with namespace-qualified names and occurrence indices, such as `/Q{...Invoice-2}Invoice[1]/Q{...CommonBasicComponents-2}ID[1]`. Attribute evidence adds `/@unitCode`. Page/frame are null and regions are empty. The source ID, revision and original SHA bind every path. Config/raw parse artifacts retain their hashes, parser script hash, Python/Expat versions and declared profile. No raster is fabricated; renderPage explicitly does not render XML. The source document has one logical completeness slot because the shared contract requires positive pageCount; it is not a physical page assertion.

Input limits: 1 MiB XML within the existing 8 MiB packet cap, UTF-8/XML 1.0 only, 4096 elements, 32 levels, 16 attributes per element, bounded attribute/scalar/text lengths and 8 MiB subprocess output. DTDs, entity declarations, external entities and processing instructions are refused. Unknown/unsupported structure retains original bytes and explicit incomplete reasons; syntax/security/runtime failures retain the original with failed extraction. Nothing resolves a URL, includes an external resource or loads a remote schema.

The positive-tax and refusal controls are in `fixtures/ap-system/formats-v1`. `scripts/ap-system/verify-formats.ts` is an evaluation harness; expected profile data is never imported by runtime parsing. Business review, purchasing evidence, coding-policy authority and payment authorization remain separate backend gates.
