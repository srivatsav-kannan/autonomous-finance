"""Independent fixtures for the Invoice Sandbox and FinBalance procedures and preparation helpers.

No downloads or answer keys: every document below is written for these tests.
"""
import io
import json
import sqlite3
import tarfile
import tempfile
import unittest
from pathlib import Path

from evidence import connect, handle
from extra_rules import finbalance_rules, invoice_sandbox_rules, ledger_balance_sheet, money, parse_ocr
from prepare_extra import FB_RULES, check_prompt_source, extract, finbalance_prompt, literal


def pdf_text(kind, number, customer_id, customer, status, total, note=''):
    title = {'invoice': 'INVOICE', 'credit': 'CREDIT MEMO', 'statement': 'CUSTOMER STATEMENT'}[kind]
    lines = ['Page 1', f'Vendor | {customer_id} | {number}', f' {title} {number}', 'Customer', customer, 'Customer ID', customer_id,
             'Status', status, 'Subtotal', total, 'Total', total]
    if note:
        lines.append(f'Notes: {note}')
    return '\n'.join(lines) + '\n\nPage 2\nService backup. Total $999999.99'


TEMPS = []


def tearDownModule():
    for temp in TEMPS:
        temp.cleanup()


class Fixture:
    def __init__(self):
        self.temp = tempfile.TemporaryDirectory()
        TEMPS.append(self.temp)
        self.path = Path(self.temp.name) / 'evidence.sqlite'
        self.con = sqlite3.connect(self.path)
        self.con.executescript('CREATE TABLE documents(path TEXT PRIMARY KEY, content TEXT); CREATE TABLE table_catalog(name TEXT, path TEXT, sheet TEXT, columns_json TEXT, row_count INTEGER);')

    def doc(self, name, content):
        self.con.execute('INSERT INTO documents VALUES (?,?)', (name, content))

    def crm(self, rows):
        self.con.execute('CREATE TABLE t001(_row INTEGER, customer_id, customer_name, aliases)')
        for i, row in enumerate(rows, 1):
            self.con.execute('INSERT INTO t001 VALUES (?,?,?,?)', (i, *row))
        self.con.execute('INSERT INTO table_catalog VALUES (?,?,?,?,?)', ('t001', 'crm/customer_master.csv', '', '[]', len(rows)))
        self.doc('crm/customer_master.csv', 'CSV table: t001')

    def open(self):
        self.con.commit()
        self.con.close()
        return connect(self.path)


def totals(answer):
    block = answer.split('\n\n')[0].splitlines()[2:]
    return {line.split(',')[0]: line.split(',')[2:] for line in block}


class InvoiceSandboxRules(unittest.TestCase):
    def setUp(self):
        self.f = Fixture()
        self.f.crm([('C001', 'Alpha Co', 'Alpha|AC'), ('C002', 'Beta LLC', 'Beta'), ('C003', 'Gamma Inc', 'Gamma')])
        self.f.doc('invoices/INV-1_C001.pdf', pdf_text('invoice', 'INV-1', 'C001', 'Alpha Co', 'PAID', '$100.00'))
        self.f.doc('invoices/INV-1_dup.pdf', pdf_text('invoice', 'INV-1', 'C001', 'Alpha Co', 'DUPLICATE_SCAN', '$100.00'))
        self.f.doc('invoices/INV-2_orig.pdf', pdf_text('invoice', 'INV-2', 'C002', 'Beta LLC', 'SUPERSEDED', '$50.00'))
        self.f.doc('invoices/INV-2_R1.pdf', pdf_text('invoice', 'INV-2-R1', 'C002', 'Beta LLC', 'OPEN', '$75.25'))
        self.f.doc('invoices/INV-3_void.pdf', pdf_text('invoice', 'INV-3', 'C002', 'Beta LLC', 'VOID', '$40.00'))
        self.f.doc('invoices/CM-1.pdf', pdf_text('credit', 'CM-1', 'C001', 'Alpha Co', 'CREDIT', '$-10.50'))
        self.f.doc('invoices/stmt.pdf', pdf_text('statement', 'STMT-1', 'C002', 'Beta LLC', 'STATEMENT', '$500.00'))
        self.f.doc('email_archive/eml/1.eml', 'The visible total is $1,000,000.00.')
        self.f.doc('bank_exports/deposits.csv', 'CSV table: t002')

    def test_applies_readme_rules_and_lists_every_crm_customer(self):
        answer = invoice_sandbox_rules(self.f.open())
        self.assertEqual(totals(answer), {
            'C001': ['1', '100.00', '10.50', '89.50'],   # duplicate counted once, credit memo subtracted
            'C002': ['1', '75.25', '0.00', '75.25'],     # revision only; void and statement excluded
            'C003': ['0', '0.00', '0.00', '0.00'],       # CRM customer with no invoices
        })
        self.assertIn('invoices/INV-1_dup.pdf,INV-1,C001,duplicate_scan,excluded_from_spend', answer)
        self.assertIn('invoices/INV-2_orig.pdf,INV-2,C002,superseded_original,excluded_from_spend', answer)
        self.assertIn('bank_exports/deposits.csv,,,bank_deposit,excluded_from_spend', answer)

    def test_resolves_aliases_and_refuses_unknown_customers_or_conflicting_copies(self):
        self.f.doc('invoices/INV-4.pdf', pdf_text('invoice', 'INV-4', 'X99', 'Gamma', 'OPEN', '$5.00'))
        self.assertEqual(totals(invoice_sandbox_rules(self.f.open()))['C003'], ['1', '5.00', '0.00', '5.00'])
        f = Fixture()
        f.crm([('C001', 'Alpha Co', 'Alpha')])
        f.doc('invoices/a.pdf', pdf_text('invoice', 'INV-9', 'C001', 'Alpha Co', 'OPEN', '$5.00'))
        f.doc('invoices/b.pdf', pdf_text('invoice', 'INV-9', 'C001', 'Alpha Co', 'OPEN', '$6.00'))
        with self.assertRaisesRegex(ValueError, 'copies disagree'):
            invoice_sandbox_rules(f.open())
        f = Fixture()
        f.crm([('C001', 'Alpha Co', 'Alpha')])
        f.doc('invoices/c.pdf', pdf_text('invoice', 'INV-8', 'C404', 'Nobody', 'OPEN', '$5.00'))
        with self.assertRaisesRegex(ValueError, 'not in the CRM master'):
            invoice_sandbox_rules(f.open())

    def test_is_reachable_through_the_evidence_worker(self):
        result = handle(self.f.open(), {'operation': 'rules', 'taskId': 'invoice-sandbox-net-spend'})
        self.assertEqual(result['status'], 'answered')


TYPES = {'Cash': 'asset', 'Accounts Receivable': 'asset', 'Input Tax Receivable': 'asset', 'Accounts Payable': 'liability',
         'Sales Tax Payable': 'liability', "Owner's Equity": 'equity', 'Retained Earnings': 'equity', 'Service Revenue': 'revenue',
         'Office Supplies Expense': 'expense', 'Travel Expense': 'expense'}


def fb_doc(doc_id, doc_type, *lines):
    return {'doc_id': doc_id, 'doc_type': doc_type, 'title': doc_type.replace('_', ' ').title(), 'ocr_text': '\n'.join(lines)}


def fb_packet(documents, regime='vat', fmt='symbol_prefix_comma'):
    f = Fixture()
    context = {'record_id': 'T1', 'period_end': '2025-08-31', 'currency_format': fmt, 'tax_regime': regime,
               'opening_balance': {'assets': {'Cash': 1000.0}, 'liabilities': {}, 'equity': {"Owner's Equity": 1000.0}},
               'allowed_accounts': list(TYPES), 'account_types': TYPES, 'inconsistency_codes': {}}
    f.doc('context.json', json.dumps(context))
    f.doc('documents.json', json.dumps(documents))
    return f


INVOICE = fb_doc('D002', 'customer_invoice', 'Invoice Details', '---------------', 'Invoice Number: INV-0001', 'Subtotal: $1,000.00',
                 'Tax Rate: 12.50%', 'Tax Amount: $125.00', 'Total: $1,125.00', '', 'Line Items', '----------', 'Items:',
                 '  - Description Consulting | Amount $400.00', '  - Description Support | Amount', '$600.00')
BILL = fb_doc('D003', 'vendor_invoice', 'Expense Label: Office Supplies Expense', 'Invoice Number: BILL-0001', 'Subtotal: $200.00',
              'Tax Rate: 20.00%', 'Tax Amount: $40.00', 'Total: $240.00', 'Lines:', '  - Description Paper | Amount $200.00')
RECEIPT = fb_doc('D004', 'expense_receipt', 'Total: $30.00', 'Lines:', '  - Description Travel Expense | Amount $10.00', '  - Description Taxi | Amount $20.00')
ADVICE = fb_doc('D005', 'payment_advice', 'Amount: $1,125.00', 'Reference: INV-0001', 'Payment For: Customer settlement')
BANK = fb_doc('D006', 'bank_statement', 'Opening Balance: $1,000.00', 'Closing Balance: $2,095.00', 'Rows:',
              '  - Date 2025-08-10 | Description receipt | Amount $-30.00 | Running Balance $970.00',
              '  - Date 2025-08-20 | Description Customer settlement INV-0001 | Amount $1,125.00 | Running', 'Balance $2,095.00')
MEMO = fb_doc('D007', 'memo', 'Narrative: Archive the binder after review; nothing', 'to post.')


class FinBalanceRules(unittest.TestCase):
    def run_rules(self, documents, **kwargs):
        return json.loads(finbalance_rules(fb_packet(documents, **kwargs).open()))

    def test_books_visible_activity_and_computes_the_balance_sheet(self):
        answer = self.run_rules([INVOICE, BILL, RECEIPT, ADVICE, BANK, MEMO])
        self.assertFalse(answer['has_inconsistency'])
        self.assertEqual([(e['doc_refs'], e['debit_account'], e['credit_account'], e['amount']) for e in answer['entries']], [
            (['D002'], 'Accounts Receivable', 'Service Revenue', 1000.0), (['D002'], 'Accounts Receivable', 'Sales Tax Payable', 125.0),
            (['D003'], 'Office Supplies Expense', 'Accounts Payable', 200.0), (['D003'], 'Input Tax Receivable', 'Accounts Payable', 40.0),
            (['D004'], 'Travel Expense', 'Cash', 30.0), (['D005', 'D002'], 'Cash', 'Accounts Receivable', 1125.0),
        ])
        self.assertEqual(answer['balance_sheet'], {
            'assets': {'Cash': 2095.0, 'Input Tax Receivable': 40.0},
            'liabilities': {'Sales Tax Payable': 125.0, 'Accounts Payable': 240.0},
            'equity': {"Owner's Equity": 1000.0, 'Retained Earnings': 770.0},
        })

    def test_us_sales_tax_on_purchases_is_embedded_in_cost(self):
        answer = self.run_rules([BILL], regime='sales_tax')
        self.assertEqual([(e['debit_account'], e['amount']) for e in answer['entries']], [('Office Supplies Expense', 240.0)])

    def test_flags_contradictions_with_upstream_codes_and_empty_answers(self):
        bad_bank = dict(BANK, ocr_text=BANK['ocr_text'].replace('Closing Balance: $2,095.00', 'Closing Balance: $2,000.00'))
        answer = self.run_rules([INVOICE, RECEIPT, ADVICE, bad_bank])
        self.assertEqual((answer['has_inconsistency'], answer['inconsistency_codes'], answer['entries']), (True, ['bank_closing_mismatch'], []))
        bad_total = dict(BILL, ocr_text=BILL['ocr_text'].replace('Total: $240.00', 'Total: $0.01'))
        self.assertEqual(self.run_rules([bad_total])['inconsistency_codes'], ['invoice_total_mismatch'])
        bad_rate = dict(BILL, ocr_text=BILL['ocr_text'].replace('Tax Amount: $40.00', 'Tax Amount: $45.00').replace('Total: $240.00', 'Total: $245.00'))
        self.assertEqual(self.run_rules([bad_rate])['inconsistency_codes'], ['tax_rate_mismatch'])

    def test_refuses_unsupported_documents_and_regimes(self):
        with self.assertRaisesRegex(ValueError, 'document type lease_agreement'):
            self.run_rules([fb_doc('D009', 'lease_agreement', 'Total: $1.00')])
        with self.assertRaisesRegex(ValueError, 'tax regime india_gst'):
            self.run_rules([INVOICE], regime='india_gst')
        with self.assertRaisesRegex(ValueError, 'matches no invoice'):
            self.run_rules([ADVICE])

    def test_parses_wrapped_lines_and_european_amounts(self):
        fields, rows = parse_ocr(BANK['ocr_text'] + '\n' + MEMO['ocr_text'])
        self.assertEqual(rows[1]['Running Balance'], '$2,095.00')
        self.assertEqual(fields['Narrative'], 'Archive the binder after review; nothing to post.')
        self.assertEqual(str(money('EUR 108.305,09', 'symbol_prefix_eu')), '108305.09')
        self.assertEqual(str(money('$-1,234.50', 'symbol_prefix_comma')), '-1234.50')

    def test_ledger_port_rolls_income_into_retained_earnings(self):
        sheet = ledger_balance_sheet({'assets': {'Cash': 10}, 'liabilities': {}, 'equity': {'Retained Earnings': 4}},
                                     [{'debit_account': 'Cash', 'credit_account': 'Service Revenue', 'amount': 2.5}], TYPES, '2025-08-31')
        self.assertEqual(sheet, {'assets': {'Cash': 12.5}, 'liabilities': {}, 'equity': {'Retained Earnings': 6.5}})


class PrepareExtraHelpers(unittest.TestCase):
    def archive(self, members):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w:gz') as tar:
            for name, data, kind in members:
                info = tarfile.TarInfo(name)
                if kind == 'link':
                    info.type, info.linkname = tarfile.SYMTYPE, '/etc/passwd'
                    tar.addfile(info)
                else:
                    info.size = len(data)
                    tar.addfile(info, io.BytesIO(data))
        return buffer.getvalue()

    def test_extracts_only_wanted_regular_files(self):
        with tempfile.TemporaryDirectory() as temp:
            data = self.archive([('repo-sha/gold_master/a.txt', b'a', 'file'), ('repo-sha/scripts/gen.py', b'x', 'file'), ('repo-sha/README.md', b'r', 'file')])
            files = extract(data, ['gold_master/', 'README.md'], Path(temp) / 'out')
            self.assertEqual(sorted(files), ['README.md', 'gold_master/a.txt'])
            for bad in ([('repo-sha/gold_master/../../escape.txt', b'x', 'file')], [('repo-sha/gold_master/link', b'', 'link')]):
                with self.assertRaises(ValueError):
                    extract(self.archive(bad), ['gold_master/'], Path(temp) / 'bad')

    def test_reads_literals_without_executing_and_checks_the_prompt_port(self):
        with tempfile.TemporaryDirectory() as temp:
            module = Path(temp) / 'codes.py'
            module.write_text('import os\nos.system("exit 1")\nCODES = {"a": "b"}\n')
            self.assertEqual(literal(module, 'CODES'), {'a': 'b'})
            source = Path(temp) / 'prompt.py'
            from prepare_extra import FB_CONTEXT_NOTE, FB_SHAPE
            source.write_text('\n'.join(repr(line) for line in FB_RULES + FB_SHAPE + [FB_CONTEXT_NOTE]))
            check_prompt_source(source)
            source.write_text(source.read_text().replace('Use only the allowed account names.', 'Use any account names.'))
            with self.assertRaisesRegex(ValueError, 'differs from the pinned source'):
                check_prompt_source(source)

    def test_prompt_shows_documents_but_not_roles_or_answers(self):
        record = {'record_id': 'R1', 'industry': 'retail', 'difficulty_level': 1, 'period_start': '2025-01-01', 'period_end': '2025-01-31',
                  'allowed_accounts': ['Cash'], 'metadata': {'period_label': 'January 2025', 'tax_regime': 'none'},
                  'documents': [{'doc_id': 'D002', 'doc_type': 'customer_invoice', 'title': 'Customer Invoice', 'role': 'posting_doc', 'ocr_text': 'Total: $1.00\n'}],
                  'expected_entries': [{'amount': 1}]}
        prompt = finbalance_prompt(record, {'bank_closing_mismatch': 'x'})
        self.assertIn('Document ID: D002\nDocument Type: customer_invoice\nDocument Title: Customer Invoice\nDocument OCR Text:\nTotal: $1.00', prompt)
        self.assertNotIn('posting_doc', prompt)
        self.assertNotIn('expected', prompt)


if __name__ == '__main__':
    unittest.main()
