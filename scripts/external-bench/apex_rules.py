"""Deterministic APEX reconciliations over public evidence, never grading keys.

These procedures deliberately prefer transaction detail and recomputed employee
amounts to draft totals or reviewer assertions. All arithmetic uses Decimal;
rounding happens only when displaying results or proposing cent-valued entries.
"""
import datetime as dt
import re
from collections import defaultdict
from decimal import Decimal, ROUND_HALF_UP

ZERO = Decimal(0)
CENT = Decimal('0.01')
GL = 'filesystem/qbo_general_ledger_detail_2024.xlsx'
CLIO = 'filesystem/clio_billing_export_2024.csv'
AR_DRAFT = 'filesystem/Draft_AR_Reconciliation_Clio_QBO_Dec_2024.xlsx'
PAYROLL = 'filesystem/gusto_payroll_register_2024.csv'
STUB = 'filesystem/workpaper_payroll_accrual_2024_12_31.xlsx'
PTO = 'filesystem/workpaper_pto_accrual_2024_12_31.xlsx'
ALLOCATION = 'filesystem/december_payroll_practice_group_allocation.xlsx'
ROLE_ACCOUNTS = {'Associate': '6000', 'Of-Counsel': '6010', 'Paralegal': '6020',
                 'Legal Assistant': '6030', 'Administrative': '6040', 'Bookkeeper': '6050'}


def decimal(value):
    if value is None or value == '':
        raise ValueError('Missing required numeric source value')
    result = Decimal(str(value).replace(',', '').replace('$', ''))
    if not result.is_finite():
        raise ValueError('Non-finite source value')
    return result


def cents(value):
    rounded = value.quantize(CENT, rounding=ROUND_HALF_UP)
    return rounded if rounded else ZERO


def money(value):
    return f'{cents(value):,.2f}'


def table_rows(db, source, sheet=''):
    found = db.execute('SELECT name FROM table_catalog WHERE path=? AND sheet=?', (source, sheet)).fetchall()
    if len(found) != 1:
        raise ValueError(f'Expected one evidence table: {source} / {sheet}')
    name = str(found[0][0]).replace('"', '""')
    return [dict(row) for row in db.execute(f'SELECT * FROM "{name}" ORDER BY _row')]


def records(db, source, sheet, required):
    rows = table_rows(db, source, sheet)
    headers = [r for r in rows if set(required).issubset(set(str(v) for v in r.values()))]
    if len(headers) != 1:
        raise ValueError(f'Missing or ambiguous column headers: {source} / {sheet}')
    header = headers[0]
    columns = {k: str(v) for k, v in header.items() if k != '_row' and v is not None}
    return [{'_row': r['_row'], **{label: r[col] for col, label in columns.items()}}
            for r in rows if r['_row'] > header['_row']]


def keyed(rows, key, prefix):
    selected = [r for r in rows if str(r.get(key, '')).startswith(prefix)]
    result = {r[key]: r for r in selected}
    if not result or len(result) != len(selected):
        raise ValueError(f'Missing or duplicate {key} records')
    return result


def ledger(db):
    rows = records(db, GL, 'GL Detail', ['Account #', 'Date', 'JE #', 'Source', 'Debit', 'Credit', 'Matter'])
    return [r for r in rows if r['Date'] and str(r['Date'])[:4] == '2024' and r['JE #']]


def net(row):
    return decimal(row['Debit'] or 0) - decimal(row['Credit'] or 0)


def ar_calculation(db):
    invoices = keyed(table_rows(db, CLIO), 'docnumber', 'INV-')
    gl = [r for r in ledger(db) if str(r['Account #']) == '1100']
    if not gl:
        raise ValueError('No AR ledger detail')
    openings = keyed(records(db, 'filesystem/opening_ar_collections_2024.xlsx', 'Collection Detail',
                             ['Prior-Year Invoice', 'Matter', 'Amount']), 'Prior-Year Invoice', 'INV-')
    opening_total = sum((decimal(r['Amount']) for r in openings.values()), ZERO)
    if cents(opening_total - sum((net(r) for r in gl if r['Source'] == 'opening_balance'), ZERO)):
        raise ValueError('Opening invoice detail does not tie to the AR opening ledger')
    by_matter = defaultdict(lambda: {'clio': ZERO, 'gl': ZERO, 'write_down': ZERO, 'write_off': ZERO})
    for row in openings.values():
        by_matter[row['Matter']]['gl'] += decimal(row['Amount'])
    unallocated = ZERO
    for row in gl:
        if row['Source'] == 'opening_balance':
            continue  # Allocate the opening entry once using its invoice detail.
        if row['Matter']:
            by_matter[row['Matter']]['gl'] += net(row)
        else:
            unallocated += net(row)
    checks = []
    for invoice in invoices.values():
        matter = by_matter[invoice['customerref_value']]
        matter['client'] = invoice['client_name']
        outstanding = decimal(invoice['outstanding_balance'])
        expected = (decimal(invoice['fees_billed']) + decimal(invoice['costs_billed'])
                    - decimal(invoice['write_down_amount']) - decimal(invoice['write_off_amount'])
                    - decimal(invoice['payment_received']))
        matter['clio'] += outstanding
        if cents(expected - outstanding):
            checks.append(f"{invoice['docnumber']}: recomputed outstanding {money(expected)} differs from source {money(outstanding)}.")
        if str(invoice['txndate']).startswith('2024-12-'):
            for key in ('write_down', 'write_off'):
                matter[key] += decimal(invoice[key + '_amount'])
    aging = keyed(records(db, 'filesystem/qbo_ar_aging_summary_2024_12_31.xlsx', 'AR Aging Summary',
                          ['Matter', 'Client', 'Total AR']), 'Matter', 'M-')
    draft = keyed(records(db, AR_DRAFT, 'Reconciliation Summary',
                          ['Matter', 'Client', 'Clio Outstanding', 'QBO Aging', 'Variance', 'Notes']), 'Matter', 'M-')
    draft_detail = keyed(records(db, AR_DRAFT, 'Matter Detail',
                                 ['Matter #', 'Clio Outstanding', 'QBO Aging']), 'Matter #', 'M-')
    tb = records(db, 'filesystem/qbo_closing_trial_balance_2024_12_31.xlsx', 'Closing TB',
                 ['Account #', 'Ending Balance'])
    ar_tb = [r for r in tb if str(r['Account #']) == '1100']
    if len(ar_tb) != 1:
        raise ValueError('Missing or ambiguous AR closing trial balance')
    totals = {key: sum((r[key] for r in by_matter.values()), ZERO)
              for key in ('clio', 'gl', 'write_down', 'write_off')}
    totals.update(gl=sum((net(r) for r in gl), ZERO), tb=decimal(ar_tb[0]['Ending Balance']),
                  annual_write_off=sum((decimal(r['write_off_amount']) for r in invoices.values()), ZERO),
                  aging=sum((decimal(r['Total AR']) for r in aging.values()), ZERO), unallocated=unallocated)
    return dict(totals=totals, matters=dict(by_matter), aging=aging, draft=draft,
                draft_detail=draft_detail, invoices=invoices, ledger=gl, checks=checks)


def ar_reconciliation(db):
    data = ar_calculation(db)
    t = data['totals']
    lines = [
        'December 2024 AR reconciliation — deterministic source-based calculation.',
        f"QBO AR account 1100, opening balance plus ledger debits less credits: {money(t['gl'])}. "
        f"Closing trial balance: {money(t['tb'])}; difference: {money(t['gl']-t['tb'])}.",
        f"Clio outstanding: {money(t['clio'])}; Clio minus QBO GL: {money(t['clio']-t['gl'])}.",
        f"Aging detail total: {money(t['aging'])}; GL minus aging: {money(t['gl']-t['aging'])}. "
        'Use the reconciled GL for the total, and investigate aging detail differences; reviewer assertions do not override transaction evidence.',
    ]
    for matter_id in sorted(set(data['draft']) | {k for k, v in data['matters'].items()
                                               if cents(v['clio']-v['gl']) or cents(v['gl']-decimal(data['aging'].get(k, {}).get('Total AR', 0)))}):
        actual = data['matters'].get(matter_id)
        if not actual:
            raise ValueError(f'Draft matter missing from sources: {matter_id}')
        aging = decimal(data['aging'].get(matter_id, {}).get('Total AR', 0))
        lines.append(f"{matter_id} {actual.get('client', '')}: Clio {money(actual['clio'])}; "
                     f"QBO GL {money(actual['gl'])}; aging {money(aging)}; actual Clio–GL variance {money(actual['clio']-actual['gl'])}.")
        if cents(actual['gl']-aging):
            lines.append(f"Correct the aging subledger by {money(actual['gl']-aging)}; do not post a GL adjustment merely to match an incorrect aging report.")
        draft = data['draft'].get(matter_id)
        detail = data['draft_detail'].get(matter_id)
        if draft:
            lines.append(f"Draft claimed variance {money(decimal(draft['Variance']))}; replace it with {money(actual['clio']-actual['gl'])}.")
            for ref in sorted(set(re.findall(r'JE-[A-Z]+-\d+', str(draft['Notes'])))):
                postings = [r for r in data['ledger'] if r['JE #'] == ref]
                if not postings:
                    lines.append(f'{ref}: no AR posting found; investigate before adjusting.')
                else:
                    credit = -sum((net(r) for r in postings), ZERO)
                    lines.append(f"{ref} is already posted to AR for {money(credit)} credit. "
                                 f"Closing balance excluding that credit {money(actual['gl']+credit)}, including it {money(actual['gl'])}; "
                                 'subtracting it again would double count the transfer. No additional timing adjustment is supported.')
            for ref in sorted(set(re.findall(r'INV-\d{4}-\d+', str(draft['Notes'])))):
                invoice = data['invoices'].get(ref)
                if not invoice:
                    raise ValueError(f'Draft invoice missing from billing evidence: {ref}')
                lines.append(f"{ref}: fees {money(decimal(invoice['fees_billed']))} + costs {money(decimal(invoice['costs_billed']))} "
                             f"− write-down {money(decimal(invoice['write_down_amount']))} − write-off {money(decimal(invoice['write_off_amount']))} "
                             f"= net invoice {money(decimal(invoice['total_invoice']))}; outstanding {money(decimal(invoice['outstanding_balance']))}. "
                             'The export already includes the reduction; do not add it back as pending processing.')
        if detail:
            lines.append(f"Draft detail Clio {money(decimal(detail['Clio Outstanding']))} → {money(actual['clio'])}; "
                         f"QBO {money(decimal(detail['QBO Aging']))} → {money(actual['gl'])}.")
    lines.append(f"December write-downs {money(t['write_down'])}; write-offs {money(t['write_off'])}; "
                 f"combined {money(t['write_down']+t['write_off'])}. Keep fee reductions separate from bad-debt write-offs.")
    lines.append(f"All-year Clio write-offs total {money(t['annual_write_off'])}; do not substitute that amount for December activity.")
    for matter_id, row in sorted(data['matters'].items()):
        if row['write_off']:
            lines.append(f"December write-off: {matter_id} {row.get('client', '')}: {money(row['write_off'])}.")
    lines.extend(data['checks'])
    unresolved = cents(t['clio']-t['gl']) or cents(t['gl']-t['tb']) or cents(t['unallocated']) or data['checks']
    unresolved = unresolved or any(cents(r['clio']-r['gl']) for r in data['matters'].values())
    lines.append('Final result: ' + ('unresolved source differences require investigation.' if unresolved else
                                    'Clio and QBO GL reconcile; remove unsupported draft timing adjustments and correct the aging/report classification only. No AR GL correcting entry is required.'))
    lines.append('Sources: Clio billing export; GL Detail; Closing TB; opening AR Collection Detail; QBO AR Aging Summary; draft Reconciliation Summary and Matter Detail. Reviewer memos are not treated as calculation authority.')
    return '\n'.join(lines)


def payroll_calculation(db):
    employees = keyed(records(db, 'filesystem/gusto_employee_earnings_summary_2024.xlsx', 'Compensation Basis',
                              ['Employee ID', 'Full Name', 'Role', 'Annual Base Salary']), 'Employee ID', 'EMP-')
    pto = keyed(records(db, PTO, 'PTO Calculation', ['Employee', 'Practice Group', 'Annual Salary',
                                                  'Accrued Days', 'Used Days', 'Accrued PTO Liability']), 'Employee', 'EMP-')
    stub = keyed(records(db, STUB, 'Accrual Summary', ['Employee', 'Annual Salary', 'Accrued Wages']), 'Employee', 'EMP-')
    if set(employees) != set(pto) or set(employees) != set(stub):
        raise ValueError('Compensation, PTO and stub employee populations differ')
    payroll = table_rows(db, PAYROLL)
    if not payroll or any(r['employee_id'] not in employees for r in payroll):
        raise ValueError('Payroll register contains missing or unmapped employees')
    december = [r for r in payroll if str(r['pay_date']).startswith('2024-12-')]
    if not december:
        raise ValueError('No December payroll records')
    payroll_ids = [(r['pay_period'], r['employee_id']) for r in payroll]
    if len(set(payroll_ids)) != len(payroll_ids):
        raise ValueError('Duplicate payroll employee/pay-period records')
    if {r['employee_id'] for r in december} != set(employees):
        raise ValueError('December payroll is missing employees')
    # Accrue the calendar gap after the final paid period, including paid holidays.
    last_end = max(dt.date.fromisoformat(r['period_end']) for r in december)
    if any(max(dt.date.fromisoformat(r['period_end']) for r in december if r['employee_id'] == employee_id) != last_end
           for employee_id in employees):
        raise ValueError('Employee payroll cutoffs differ')
    cycles = {(dt.date.fromisoformat(r['period_end'])-dt.date.fromisoformat(r['period_start'])).days+1 for r in december}
    if len(cycles) != 1 or next(iter(cycles)) != 14:
        raise ValueError('This baseline requires the supplied biweekly payroll cycle')
    stub_days = (dt.date(2024, 12, 31)-last_end).days
    if not 0 <= stub_days <= 14:
        raise ValueError('Unexpected year-end payroll cutoff')
    factor = Decimal(stub_days) / 14
    ytd, gross = defaultdict(lambda: ZERO), defaultdict(lambda: ZERO)
    for row in payroll:
        if str(row['pay_date']).startswith('2024-'):
            ytd[row['employee_id']] += decimal(row['gross_pay'])
    for row in december:
        gross[row['employee_id']] += decimal(row['gross_pay'])
    gl = [r for r in ledger(db) if str(r['Date']).startswith('2024-12-')]
    booked = {source: defaultdict(lambda: ZERO) for source in ('payroll', 'aje_payroll_stub', 'aje_pto')}
    for row in gl:
        if row['Source'] in booked:
            booked[row['Source']][str(row['Account #'])] += net(row)
    if any(not values for values in booked.values()):
        raise ValueError('Missing December payroll or adjustment ledger postings')
    groups = defaultdict(lambda: {'gross': ZERO, 'stub': ZERO, 'pto': ZERO})
    target_stub, target_pto, gross_roles = (defaultdict(lambda: ZERO) for _ in range(3))
    detail = []
    for employee_id, employee in employees.items():
        salary = decimal(employee['Annual Base Salary'])
        if salary != decimal(pto[employee_id]['Annual Salary']) or salary != decimal(stub[employee_id]['Annual Salary']):
            raise ValueError(f'Conflicting salary source for {employee_id}')
        account = ROLE_ACCOUNTS[employee['Role']]
        group = pto[employee_id]['Practice Group']
        if not group:
            raise ValueError(f'Missing practice group: {employee_id}')
        # Rates, wage base and carryover cap are the supplied 2024 workpaper policy,
        # not current tax guidance. No rounded cached accrual/daily rate is reused.
        wages = salary / 26 * factor
        ss = min(wages, max(ZERO, Decimal(168600)-ytd[employee_id])) * Decimal('0.062')
        taxes = ss + wages * (Decimal('0.0145') + Decimal('0.006'))
        match = wages * Decimal('0.03')
        days = min(Decimal(5), max(ZERO, decimal(pto[employee_id]['Accrued Days'])-decimal(pto[employee_id]['Used Days'])))
        pto_amount = salary / 260 * days
        groups[group]['gross'] += gross[employee_id]
        groups[group]['stub'] += wages + taxes + match
        groups[group]['pto'] += pto_amount
        gross_roles[account] += gross[employee_id]
        target_stub[account] += wages
        target_stub['6100'] += taxes
        target_stub['6120'] += match
        target_pto[account] += pto_amount
        detail.append(dict(id=employee_id, name=employee['Full Name'], group=group, salary=salary,
                           wages=wages, stub=wages+taxes+match, pto=pto_amount,
                           prior_pto=decimal(pto[employee_id]['Accrued PTO Liability']), days=days))
    drafts = records(db, ALLOCATION, 'Summary', ['Practice Group', 'Gusto Gross Pay', 'AJE-03 Stub Accrual', 'AJE-04 PTO Accrual', 'Total December Payroll'])
    draft = {r['Practice Group']: r for r in drafts if r['Practice Group'] in groups}
    if set(draft) != set(groups):
        raise ValueError('Draft practice groups differ from employee allocation')
    return dict(groups=dict(groups), employees=detail, booked=booked, target_stub=dict(target_stub),
                target_pto=dict(target_pto), gross_roles=dict(gross_roles), draft=draft, stub_days=stub_days)


def correcting_entry(target, booked):
    """Round target expense accounts at posting time; balance the liability in cents."""
    expense = {k: cents(target.get(k, ZERO))-cents(booked.get(k, ZERO))
               for k in sorted(set(target) | (set(booked)-{'2100'}))}
    target_liability = -sum((cents(v) for v in target.values()), ZERO)
    expense['2100'] = target_liability-cents(booked.get('2100', ZERO))
    if sum(expense.values(), ZERO):
        raise ValueError('Booked adjustment is unbalanced; cannot propose a balanced correction')
    return {k: v for k, v in expense.items() if v}


def payroll_reconciliation(db):
    data = payroll_calculation(db)
    lines = ['December 2024 payroll reconciliation — deterministic employee-level calculation.',
             'Basis consistent with the management workpaper: December Gusto gross (including bonuses) + stub wages/employer taxes/401(k) + PTO. Regular-payroll employer costs are outside this subtotal.',
             f"Stub: {data['stub_days']}/14 × annual salary/26 for every salaried role. Paid holidays do not shorten this calendar accrual; the memo's Associate-only holiday exclusion is unsupported by the payroll cutoff. Bonuses excluded from stub/PTO salary rates.",
             'Employer stub: SS 6.2% capped at remaining 168,600.00 YTD wages; Medicare 1.45%, workers compensation 0.60%, safe-harbor 401(k) 3.00%. FUTA/SUTA wage bases already exhausted; health insurance not accrued again.',
             'PTO: annual salary/260 × min(5, max(0, accrued days − used days)); retain full precision until the final totals.']
    for group, row in data['groups'].items():
        total = sum(row.values(), ZERO)
        draft = data['draft'][group]
        lines.append(f"{group}: Gusto gross {money(row['gross'])}; corrected stub {money(row['stub'])}; "
                     f"corrected PTO {money(row['pto'])}; total {money(total)}; "
                     f"draft total {money(decimal(draft['Total December Payroll']))}; correction {money(total-decimal(draft['Total December Payroll']))}.")
    for account, gross in sorted(data['gross_roles'].items()):
        posted = data['booked']['payroll'].get(account, ZERO)
        lines.append(f"Gusto vs QBO salary account {account}: {money(gross)} vs {money(posted)}; difference {money(gross-posted)}.")
    for label, target, source in [('AJE-03 stub', data['target_stub'], 'aje_payroll_stub'), ('AJE-04 PTO', data['target_pto'], 'aje_pto')]:
        lines.append(f'{label} expense accounts (booked → recomputed): ' + '; '.join(
            f"{account}: {money(data['booked'][source].get(account, ZERO))} → {money(amount)}" for account, amount in sorted(target.items())))
        entry = correcting_entry(target, data['booked'][source])
        lines.append(f'{label} correcting entry: ' + ('; '.join(f"{'Dr' if amount > 0 else 'Cr'} {account} {money(abs(amount))}" for account, amount in entry.items()) if entry else 'none required') + '.')
    for employee in data['employees']:
        delta = cents(employee['pto'])-cents(employee['prior_pto'])
        if delta:
            lines.append(f"PTO detail correction {employee['id']} {employee['name']} ({employee['group']}): "
                         f"salary {money(employee['salary'])}/260 × {employee['days']} days = {money(employee['pto'])}; "
                         f"workpaper {money(employee['prior_pto'])}; change {money(delta)}.")
    totals = {k: sum((g[k] for g in data['groups'].values()), ZERO) for k in ('gross', 'stub', 'pto')}
    lines.append(f"Firm-wide: Gusto gross {money(totals['gross'])} + corrected stub {money(totals['stub'])} "
                 f"+ corrected PTO {money(totals['pto'])} = {money(sum(totals.values(), ZERO))}.")
    lines.extend(['Rebuild the practice-group allocation from individual employees; a balanced journal total does not validate role or group allocations. QBO payroll has no practice-group classes, so these group totals are analytical allocations.',
                  'Proposed entries compare rounded account targets to actual postings and balance to 2100. Account-level rounding can differ by cents from full-precision aggregate totals. Amend the stub reversal consistently; do not book a second full accrual.',
                  'Sources: Gusto payroll register and Compensation Basis; GL Detail; payroll Accrual Summary; PTO Policy and PTO Calculation; December allocation Summary. The holiday memo and draft are checked against detail, not accepted as numeric authority.'])
    return '\n'.join(lines)
