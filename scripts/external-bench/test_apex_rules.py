"""Independent small source fixtures: no downloaded data or grading keys needed."""
import sqlite3
import unittest
from decimal import Decimal as D

from apex_rules import (ALLOCATION, AR_DRAFT, CLIO, GL, PAYROLL, PTO, STUB,
                        ar_calculation, ar_reconciliation, cents, correcting_entry,
                        payroll_calculation, payroll_reconciliation)
from evidence import handle


class SourceFixture:
    def __init__(self):
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        self.db.execute('CREATE TABLE table_catalog(name,path,sheet)')
        self.next_table = 0
        self.tables = {}

    def add(self, source, sheet, columns, rows, csv=False):
        self.next_table += 1
        name = f't{self.next_table:03}'
        self.tables[source, sheet] = name
        fields = columns if csv else [f'c{i+1}' for i in range(len(columns))]
        self.db.execute(f'CREATE TABLE {name}(_row INTEGER,' + ','.join('"'+c+'"' for c in fields) + ')')
        values = rows if csv else [columns, *rows]
        self.db.executemany(f'INSERT INTO {name} VALUES(' + ','.join('?' for _ in range(len(columns)+1)) + ')',
                            [[i+1, *row] for i, row in enumerate(values)])
        self.db.execute('INSERT INTO table_catalog VALUES(?,?,?)', (name, source, sheet))

    def update(self, source, sheet, column, value, where, key):
        self.db.execute(f'UPDATE {self.tables[source, sheet]} SET "{column}"=? WHERE "{where}"=?', (value, key))


def ar_fixture():
    f = SourceFixture()
    f.add(CLIO, '', ['docnumber', 'customerref_value', 'client_name', 'txndate', 'fees_billed', 'costs_billed',
                     'write_down_amount', 'write_off_amount', 'payment_received', 'outstanding_balance', 'total_invoice'], [
        ['INV-2024-1', 'M-1', 'Alpha', '2024-12-15', 100, 0, 20, 0, 20, 60, 80],
        ['INV-2024-2', 'M-2', 'Beta', '2024-12-31', 200, 0, 0, 5, 45, 150, 195],
        ['INV-2024-3', 'M-2', 'Beta', '2024-09-01', 50, 0, 0, 50, 0, 0, 0],
    ], csv=True)
    f.add(GL, 'GL Detail', ['Account #', 'Date', 'JE #', 'Source', 'Debit', 'Credit', 'Matter'], [
        ['1100', '2024-01-01', 'OPEN', 'opening_balance', 100, None, None],
        ['1100', '2024-02-01', 'COLLECT', 'prior_collection', None, 100, 'M-1'],
        ['1100', '2024-12-15', 'INV1', 'billing', 80, None, 'M-1'],
        ['1100', '2024-12-16', 'PAY1', 'payment', None, 20, 'M-1'],
        ['1100', '2024-12-31', 'INV2', 'billing', 195, None, 'M-2'],
        ['1100', '2024-12-31', 'JE-OB-10', 'iolta', None, 45, 'M-2'],
        ['1100', '2025-01-01', 'NEXTYEAR', 'billing', 999, None, 'M-2'],
    ])
    f.add('filesystem/opening_ar_collections_2024.xlsx', 'Collection Detail',
          ['Prior-Year Invoice', 'Matter', 'Amount'], [['INV-2023-1', 'M-1', 100]])
    f.add('filesystem/qbo_closing_trial_balance_2024_12_31.xlsx', 'Closing TB',
          ['Account #', 'Ending Balance'], [['1100', 210]])
    f.add('filesystem/qbo_ar_aging_summary_2024_12_31.xlsx', 'AR Aging Summary',
          ['Matter', 'Client', 'Total AR'], [['M-1', 'Alpha', 58], ['M-2', 'Beta', 150], ['TOTAL', '', 999999]])
    f.add(AR_DRAFT, 'Reconciliation Summary', ['Matter', 'Client', 'Clio Outstanding', 'QBO Aging', 'Variance', 'Notes'], [
        ['M-1', 'Alpha', 80, 58, 22, 'INV-2024-1 reduction pending; add back 20'],
        ['M-2', 'Beta', 150, 105, 45, 'JE-OB-10 not posted; subtract again'],
    ])
    f.add(AR_DRAFT, 'Matter Detail', ['Matter #', 'Clio Outstanding', 'QBO Aging'], [['M-1', 80, 58], ['M-2', 150, 105]])
    return f


def payroll_fixture():
    f = SourceFixture()
    f.add('filesystem/gusto_employee_earnings_summary_2024.xlsx', 'Compensation Basis',
          ['Employee ID', 'Full Name', 'Role', 'Annual Base Salary'],
          [['EMP-A', 'Alice', 'Associate', 26000], ['EMP-B', 'Bob', 'Of-Counsel', 52000]])
    f.add(PTO, 'PTO Calculation', ['Employee', 'Practice Group', 'Annual Salary', 'Accrued Days', 'Used Days', 'Accrued PTO Liability'],
          [['EMP-A', 'Litigation', 26000, 10, 3, 900], ['EMP-B', 'Corporate', 52000, 10, 12, 100]])
    f.add(STUB, 'Accrual Summary', ['Employee', 'Annual Salary', 'Accrued Wages'],
          [['EMP-A', 26000, 800], ['EMP-B', 52000, 1800]])
    f.add(PAYROLL, '', ['pay_period', 'pay_date', 'period_start', 'period_end', 'employee_id', 'gross_pay'], [
        ['24', '2024-11-22', '2024-11-08', '2024-11-21', 'EMP-A', 166500],
        ['24', '2024-11-22', '2024-11-08', '2024-11-21', 'EMP-B', 60000],
        ['25', '2024-12-06', '2024-11-22', '2024-12-05', 'EMP-A', 1000],
        ['25', '2024-12-06', '2024-11-22', '2024-12-05', 'EMP-B', 2000],
        ['26', '2024-12-20', '2024-12-06', '2024-12-19', 'EMP-A', 1000],
        ['26', '2024-12-20', '2024-12-06', '2024-12-19', 'EMP-B', 2000],
    ], csv=True)
    entries = []
    for source, amounts in [('payroll', {'6000': 2000, '6010': 4000}),
                            ('aje_payroll_stub', {'6000': 800, '6010': 1800, '6100': 300, '6120': 60, '2100': -2960}),
                            ('aje_pto', {'6000': 900, '6010': 100, '2100': -1000})]:
        for account, value in amounts.items():
            entries.append([account, '2024-12-31', source, source, max(value, 0), max(-value, 0), None])
    f.add(GL, 'GL Detail', ['Account #', 'Date', 'JE #', 'Source', 'Debit', 'Credit', 'Matter'], entries)
    f.add(ALLOCATION, 'Summary', ['Practice Group', 'Gusto Gross Pay', 'AJE-03 Stub Accrual', 'AJE-04 PTO Accrual', 'Total December Payroll'],
          [['Litigation', 2000, 1000, 900, 3900], ['Corporate', 4000, 1960, 100, 6060]])
    return f


class ARTests(unittest.TestCase):
    def setUp(self): self.f = ar_fixture()
    def tearDown(self): self.f.db.close()

    def test_reconciles_opening_and_current_activity_without_double_counting(self):
        result = ar_calculation(self.f.db)
        self.assertEqual(result['totals']['gl'], D(210))
        self.assertEqual(result['totals']['clio'], D(210))
        self.assertEqual(result['matters']['M-1']['gl'], D(60))
        answer = handle(self.f.db, {'operation': 'rules', 'taskId': 'apex-13'})
        self.assertEqual(answer['status'], 'answered')
        self.assertIn('already posted to AR for 45.00 credit', answer['answer'])
        self.assertIn('Correct the aging subledger by 2.00', answer['answer'])
        self.assertIn('No AR GL correcting entry is required', answer['answer'])

    def test_december_classification_excludes_annual_writeoffs_and_summary_rows(self):
        totals = ar_calculation(self.f.db)['totals']
        self.assertEqual(totals['write_down'], D(20))
        self.assertEqual(totals['write_off'], D(5))
        self.assertEqual(totals['annual_write_off'], D(55))
        self.assertEqual(totals['aging'], D(208))

    def test_changed_transaction_produces_unresolved_variance(self):
        self.f.update(GL, 'GL Detail', 'c6', 40, 'c3', 'JE-OB-10')
        result = ar_calculation(self.f.db)
        self.assertEqual(result['totals']['gl'], D(215))
        self.assertIn('unresolved source differences', ar_reconciliation(self.f.db))

    def test_corrupt_invoice_equation_is_flagged_even_if_ledger_totals_tie(self):
        self.f.update(CLIO, '', 'fees_billed', 101, 'docnumber', 'INV-2024-1')
        answer = ar_reconciliation(self.f.db)
        self.assertIn('recomputed outstanding 61.00 differs from source 60.00', answer)
        self.assertIn('unresolved source differences', answer)

    def test_missing_values_and_inconsistent_opening_detail_fail_explicitly(self):
        self.f.update(CLIO, '', 'fees_billed', None, 'docnumber', 'INV-2024-1')
        with self.assertRaisesRegex(ValueError, 'Missing required numeric'):
            ar_calculation(self.f.db)
        self.f.update(CLIO, '', 'fees_billed', 100, 'docnumber', 'INV-2024-1')
        self.f.update('filesystem/opening_ar_collections_2024.xlsx', 'Collection Detail', 'c3', 99, 'c1', 'INV-2023-1')
        with self.assertRaisesRegex(ValueError, 'Opening invoice detail'):
            ar_calculation(self.f.db)


class PayrollTests(unittest.TestCase):
    def setUp(self): self.f = payroll_fixture()
    def tearDown(self): self.f.db.close()

    def test_employee_accruals_apply_ss_wage_cap_and_pto_bounds(self):
        result = payroll_calculation(self.f.db)
        self.assertEqual(result['stub_days'], 12)
        self.assertEqual(cents(result['target_stub']['6100']), D('165.20'))
        self.assertEqual(cents(result['target_stub']['6000']), D('857.14'))
        self.assertEqual(cents(result['target_stub']['6010']), D('1714.29'))
        self.assertEqual(result['groups']['Litigation']['pto'], D(500))
        self.assertEqual(result['groups']['Corporate']['pto'], D(0))
        self.assertEqual(result['groups']['Litigation']['gross'], D(2000))
        self.assertEqual(cents(sum(sum(g.values(), D(0)) for g in result['groups'].values())), D('9313.77'))
        self.assertEqual(handle(self.f.db, {'operation': 'rules', 'taskId': 'apex-17'})['status'], 'answered')

    def test_correcting_entries_are_balanced_and_replace_actual_booked_amounts(self):
        result = payroll_calculation(self.f.db)
        for key, source in [('target_stub', 'aje_payroll_stub'), ('target_pto', 'aje_pto')]:
            entry = correcting_entry(result[key], result['booked'][source])
            self.assertEqual(sum(entry.values(), D(0)), D(0))
            for account, target in result[key].items():
                self.assertEqual(result['booked'][source].get(account, D(0))+entry.get(account, D(0)), cents(target))
        self.assertEqual(correcting_entry(result['target_pto'], result['booked']['aje_pto']),
                         {'6000': D(-400), '6010': D(-100), '2100': D(500)})
        with self.assertRaisesRegex(ValueError, 'unbalanced'):
            correcting_entry({'6000': D(50)}, {'6000': D(40), '2100': D(-39)})

    def test_salary_changes_recompute_pto_and_stub_without_reusing_draft_totals(self):
        self.f.update('filesystem/gusto_employee_earnings_summary_2024.xlsx', 'Compensation Basis', 'c4', 52000, 'c1', 'EMP-A')
        self.f.update(PTO, 'PTO Calculation', 'c3', 52000, 'c1', 'EMP-A')
        self.f.update(STUB, 'Accrual Summary', 'c2', 52000, 'c1', 'EMP-A')
        result = payroll_calculation(self.f.db)
        self.assertEqual(cents(result['target_stub']['6000']), D('1714.29'))
        self.assertEqual(result['groups']['Litigation']['pto'], D(1000))
        self.assertEqual(result['groups']['Litigation']['gross'], D(2000))
        self.assertIn('Alice', payroll_reconciliation(self.f.db))

    def test_cutoff_changes_apply_to_every_employee(self):
        self.f.update(PAYROLL, '', 'period_start', '2024-12-07', 'pay_period', '26')
        self.f.update(PAYROLL, '', 'period_end', '2024-12-20', 'pay_period', '26')
        result = payroll_calculation(self.f.db)
        self.assertEqual(result['stub_days'], 11)
        self.assertEqual(cents(result['target_stub']['6000']), D('785.71'))
        self.assertEqual(cents(result['target_stub']['6010']), D('1571.43'))

    def test_missing_employee_mapping_is_an_error_not_a_zero_cost(self):
        self.f.update(PTO, 'PTO Calculation', 'c1', 'EMP-UNKNOWN', 'c1', 'EMP-A')
        with self.assertRaisesRegex(ValueError, 'populations differ'):
            payroll_calculation(self.f.db)

    def test_duplicate_payroll_records_are_rejected(self):
        table = self.f.tables[PAYROLL, '']
        self.f.db.execute(f'INSERT INTO {table} SELECT * FROM {table} WHERE _row=1')
        with self.assertRaisesRegex(ValueError, 'Duplicate payroll'):
            payroll_calculation(self.f.db)


if __name__ == '__main__': unittest.main()
