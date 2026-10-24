// The task statement both systems receive. The rules are the public "Scoring Contract" and
// "Dataset Rules" sections of the benchmark README; nothing here comes from the answer key.
export const TASK_TEXT = `TASK
You are reconciling an accounts-receivable document workspace: invoice PDFs, emails (.eml files and an .mbox archive), bank deposit exports, a CRM customer master with customer aliases, operations files and notes.

For every customer in the CRM customer master, report:
- valid_invoice_count: number of valid invoices counted for the customer
- gross_invoice_spend_usd: sum of the totals of those valid invoices
- credit_memo_total_usd: sum of the customer's credit memos, as a positive amount (credit memos are not invoices)
- net_spend_usd: gross_invoice_spend_usd - credit_memo_total_usd
Also list every excluded or suspicious document with a reason.

DATASET RULES (from the benchmark README)
net_spend_usd = included valid invoices - credit memos
Do not count:
- Voided invoices.
- Superseded originals when a revision exists.
- Duplicate scans.
- Statement summaries.
- Email text that quotes an invoice total without an actual invoice record.
- Bank deposits as spend.

OUTPUT FORMAT
- Money values are decimal strings with exactly two decimals, no "$" or thousands separators (e.g. "12345.67"). Use "0.00" for none.
- Include every CRM customer, even when all values are zero.
- Use the CRM customer_id values (e.g. "C001").
- excluded/suspicious documents: give the workspace-relative path (e.g. "invoices/<file>.pdf"), the document id if any, the customer_id if known, a category, the treatment you applied, and a one-sentence reason. treatment is "excluded_from_spend" (not counted at all), "subtracted_as_credit" (credit memo subtracted from net spend) or "counted_with_flag" (counted, but worth a human look).`;
