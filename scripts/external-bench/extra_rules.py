"""Deterministic baselines for the opt-in Invoice Sandbox and FinBalance cases.

Both read only public evidence (the documents table). Invoice Sandbox follows the README's
dataset rules; FinBalance follows the upstream prompt's accounting rules for the document
types present in the pinned records. Neither opens grading keys. Unsupported documents raise
explicit errors instead of guessing; these are fixed-batch procedures, not general engines.
"""
import csv
import io
import json
import re
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

CENT = Decimal('0.01')


def _document(db, name):
    row = db.execute('SELECT content FROM documents WHERE path=?', (name,)).fetchone()
    if row is None:
        raise ValueError(f'Missing public document {name}')
    return row[0]


# ---------- Invoice Sandbox ----------

def _usd(text):
    try:
        return Decimal(text.strip().replace('$', '').replace(',', '')).quantize(CENT)
    except (InvalidOperation, AttributeError):
        raise ValueError(f'Invalid money value {text!r}')


def _first_page(content):
    return content.split('\n\nPage 2\n', 1)[0]


def parse_ar_document(path, content):
    """Fields from an Invoice Sandbox PDF's first page (pypdf text: each label on its own line)."""
    lines = [line.strip() for line in _first_page(content).splitlines()]
    def after(label):
        if label not in lines or lines.index(label) + 1 >= len(lines):
            raise ValueError(f'{path}: missing {label}')
        return lines[lines.index(label) + 1]
    title = next((l for l in lines if re.match(r'^(INVOICE|CREDIT MEMO|CUSTOMER STATEMENT) \S+$', l)), None)
    if title is None:
        raise ValueError(f'{path}: no document title')
    kind, number = title.rsplit(' ', 1)
    return {
        'path': path, 'kind': kind, 'number': number, 'customer_id': after('Customer ID'), 'customer': after('Customer'),
        'status': after('Status').upper(), 'total': _usd(after('Total')),
        'notes': ' '.join(l for l in lines if l.startswith('Notes:') or l.startswith('Processing warning:')),
    }


def _csv_row(values):
    out = io.StringIO()
    csv.writer(out, lineterminator='').writerow(values)
    return out.getvalue()


def invoice_sandbox_rules(db):
    tables = [r[0] for r in db.execute("SELECT name FROM table_catalog WHERE path='crm/customer_master.csv'")]
    if len(tables) != 1:
        raise ValueError('Expected one CRM customer master table')
    crm = [dict(r) for r in db.execute(f'SELECT customer_id, customer_name, aliases FROM {tables[0]} ORDER BY _row')]
    by_id = {c['customer_id']: c for c in crm}
    norm = lambda s: re.sub(r'[^a-z0-9]', '', s.lower())
    aliases = {norm(a): c['customer_id'] for c in crm for a in [c['customer_name'], *c['aliases'].split('|')] if a}
    docs = [parse_ar_document(r[0], r[1]) for r in db.execute("SELECT path, content FROM documents WHERE path LIKE 'invoices/%.pdf' ORDER BY path")]
    if not docs:
        raise ValueError('No invoice PDFs in public evidence')
    for d in docs:
        if d['customer_id'] not in by_id:
            resolved = aliases.get(norm(d['customer']))
            if resolved is None:
                raise ValueError(f'{d["path"]}: customer {d["customer_id"]} / {d["customer"]} is not in the CRM master')
            d['customer_id'] = resolved
    excluded, credits, invoices = [], [], []
    for d in docs:
        if d['kind'] == 'CUSTOMER STATEMENT' or d['status'] == 'STATEMENT':
            excluded.append((d, 'statement_summary', 'excluded_from_spend', 'Statement summaries are reference artifacts, not invoices.'))
        elif d['kind'] == 'CREDIT MEMO':
            credits.append(d)
            excluded.append((d, 'credit_memo', 'subtracted_as_credit', 'Credit memo subtracted from net spend; not a valid invoice.'))
        elif d['status'] == 'VOID':
            excluded.append((d, 'void', 'excluded_from_spend', 'Voided invoice.'))
        else:
            invoices.append(d)
    # Superseded originals: an invoice whose number has a revision (NUMBER-R<n>) in the packet.
    revisions = {}
    for d in invoices:
        m = re.fullmatch(r'(.+)-R(\d+)', d['number'])
        if m:
            revisions.setdefault(m.group(1), []).append((int(m.group(2)), d))
    kept = []
    for d in invoices:
        base = re.sub(r'-R\d+$', '', d['number'])
        latest = max(revisions[base], key=lambda x: x[0])[1] if base in revisions else None
        if (latest is not None and d is not latest) or (latest is None and d['status'] == 'SUPERSEDED'):
            excluded.append((d, 'superseded_original', 'excluded_from_spend', 'Superseded by a revised invoice.' if latest else 'Marked superseded.'))
        else:
            kept.append(d)
    # Duplicate scans: one invoice number in several PDFs counts once.
    counted, by_number = [], {}
    for d in kept:
        by_number.setdefault(d['number'], []).append(d)
    for number, copies in sorted(by_number.items()):
        if len({c['total'] for c in copies}) > 1 or len({c['customer_id'] for c in copies}) > 1:
            raise ValueError(f'{number}: copies disagree on total or customer; no deterministic duplicate rule')
        primary = sorted(copies, key=lambda c: (c['status'] == 'DUPLICATE_SCAN', c['path']))[0]
        counted.append(primary)
        for c in copies:
            if c is not primary:
                excluded.append((c, 'duplicate_scan', 'excluded_from_spend', f'Duplicate scan of {number}; counted once.'))
        if primary['status'] == 'DUPLICATE_SCAN':
            excluded.append((primary, 'duplicate_scan', 'counted_with_flag', 'Marked as a duplicate scan but no other copy exists.'))
    rows = []
    for c in crm:
        mine = [d for d in counted if d['customer_id'] == c['customer_id']]
        gross = sum((d['total'] for d in mine), Decimal(0))
        credit = sum((abs(d['total']) for d in credits if d['customer_id'] == c['customer_id']), Decimal(0))
        rows.append(_csv_row([c['customer_id'], c['customer_name'], len(mine), f'{gross:.2f}', f'{credit:.2f}', f'{gross - credit:.2f}']))
    excluded.sort(key=lambda x: x[0]['path'])
    suspicious = [_csv_row([d['path'], d['number'], d['customer_id'], category, treatment, reason]) for d, category, treatment, reason in excluded]
    bank = [r[0] for r in db.execute("SELECT path FROM documents WHERE path LIKE 'bank_exports/%' ORDER BY path")]
    suspicious += [_csv_row([p, '', '', 'bank_deposit', 'excluded_from_spend', 'Bank deposits are payments, not spend.']) for p in bank]
    return '\n'.join([
        'CUSTOMER TOTALS', 'customer_id,customer_name,valid_invoice_count,gross_invoice_spend_usd,credit_memo_total_usd,net_spend_usd', *rows, '',
        'EXCLUDED OR SUSPICIOUS DOCUMENTS', 'path,document_id,customer_id,category,treatment,reason', *suspicious,
    ])


# ---------- FinBalance ----------

UNDERLINE = re.compile(r'^\s*[=-]{3,}\s*$')
FIELD = re.compile(r'^([A-Z][A-Za-z /()&.-]*): ?(.*)$')
CELL_KEYS = ('Running Balance', 'Document Type', 'Description', 'Reference', 'Section', 'Account', 'Amount', 'Status', 'Tenant', 'Date', 'Unit')


def parse_ocr(text):
    """Key/value fields (first occurrence wins) and list items, rejoining lines the renderer wrapped."""
    lines = text.splitlines()
    fields, items, last = {}, [], None
    for i, line in enumerate(lines):
        following = lines[i + 1] if i + 1 < len(lines) else ''
        if not line.strip() or UNDERLINE.match(line) or UNDERLINE.match(following):
            last = None
            continue
        if line.startswith('  - '):
            items.append(line[4:].strip())
            last = ('item', len(items) - 1)
        elif FIELD.match(line):
            key, value = FIELD.match(line).groups()
            if key not in fields:
                fields[key] = value.strip()
                last = ('field', key)
            else:
                last = None
        elif last and last[0] == 'item':
            items[last[1]] += ' ' + line.strip()
        elif last and last[0] == 'field':
            fields[last[1]] += ' ' + line.strip()
    rows = []
    for item in items:
        row = {}
        for cell in (c.strip() for c in item.split(' | ')):
            key = next((k for k in CELL_KEYS if cell == k or cell.startswith(k + ' ')), None)
            if key is None:
                raise ValueError(f'Unrecognized list cell {cell!r}')
            row[key] = cell[len(key):].strip()
        rows.append(row)
    return fields, rows


def money(text, currency_format):
    s = re.sub(r'[^0-9,.\-]', '', text or '')
    if currency_format == 'symbol_prefix_eu':
        s = s.replace('.', '').replace(',', '.')
    elif currency_format == 'symbol_prefix_comma':
        s = s.replace(',', '')
    else:
        raise ValueError(f'Unsupported currency format {currency_format}')
    try:
        return Decimal(s).quantize(CENT)
    except InvalidOperation:
        raise ValueError(f'Invalid amount {text!r}')


def ledger_balance_sheet(opening, entries, account_types, period_end):
    """Port of finbalance.ledger.Ledger: opening balances plus postings, in cents."""
    balances = {}
    for section in ('assets', 'liabilities', 'equity'):
        for account, value in opening.get(section, {}).items():
            balances[account] = Decimal(str(value)).quantize(CENT)
    for e in entries:
        amount = Decimal(str(e['amount'])).quantize(CENT, ROUND_HALF_UP)
        for account, sign in ((e['debit_account'], 1), (e['credit_account'], -1)):
            normal = 1 if account_types[account] in ('asset', 'expense') else -1
            balances[account] = balances.get(account, Decimal(0)) + sign * normal * amount
    sheet, revenue, expense = {'assets': {}, 'liabilities': {}, 'equity': {}}, Decimal(0), Decimal(0)
    sections = {'asset': 'assets', 'contra_asset': 'assets', 'liability': 'liabilities', 'equity': 'equity'}
    for account, balance in balances.items():
        kind = account_types[account]
        if kind == 'revenue':
            revenue += balance
        elif kind == 'expense':
            expense += balance
        else:
            rendered = -balance if kind == 'contra_asset' else balance
            if rendered != 0:
                sheet[sections[kind]][account] = float(rendered)
    retained = revenue - expense
    if retained != 0:
        sheet['equity']['Retained Earnings'] = float(Decimal(str(sheet['equity'].get('Retained Earnings', 0))) + retained)
    return sheet


def finbalance_rules(db):
    ctx = json.loads(_document(db, 'context.json'))
    docs = json.loads(_document(db, 'documents.json'))
    fmt, types, allowed = ctx['currency_format'], ctx['account_types'], set(ctx['allowed_accounts'])
    amount = lambda value: money(value, fmt)
    revenue = [a for a in ctx['allowed_accounts'] if types.get(a) == 'revenue' and a not in ('Foreign Exchange Gain', 'Gain on Disposal', 'Other Income')]
    if len(revenue) != 1:
        raise ValueError(f'Expected one operating revenue account, found {revenue}')
    regime = ctx['tax_regime']
    if regime not in ('none', 'vat', 'gst', 'sales_tax', 'us_sales_tax'):
        raise ValueError(f'No deterministic procedure for tax regime {regime}')
    recoverable = regime in ('vat', 'gst')  # US sales tax on purchases is embedded in cost (prompt rule)
    parsed = {d['doc_id']: (d, *parse_ocr(d['ocr_text'])) for d in docs}
    issues, entries = [], []
    def flag(code, note):
        if code not in [c for c, _ in issues]:
            issues.append((code, note))
    withdrawn = {f.get('Withdrawn Reference') for d, f, _ in parsed.values() if d['doc_type'] == 'cancellation_note'}
    by_number = {}
    for doc_id, (d, f, rows) in parsed.items():
        if d['doc_type'] in ('customer_invoice', 'vendor_invoice', 'supplier_invoice') and f.get('Invoice Number') not in withdrawn:
            by_number[f['Invoice Number']] = doc_id

    def check_document(doc_id, f, rows, total):
        lines = sum((amount(r['Amount']) for r in rows), Decimal(0))
        tax = amount(f['Tax Amount']) if 'Tax Amount' in f else Decimal(0)
        if 'Tax Rate' in f and 'Subtotal' in f:
            rate = Decimal(f['Tax Rate'].rstrip('%')) / 100
            if abs((amount(f['Subtotal']) * rate).quantize(CENT, ROUND_HALF_UP) - tax) > CENT:
                flag('tax_rate_mismatch', f'{doc_id}: tax does not equal rate times subtotal.')
        if rows and lines + tax != total:
            # Ambiguity: with lines equal to the subtotal, "total != lines + tax" fits both
            # invoice_total_mismatch and tax_total_mismatch; this procedure reports the former.
            flag('invoice_total_mismatch', f'{doc_id}: total does not equal the visible line items plus tax.')
        elif not rows and 'Subtotal' in f and amount(f['Subtotal']) + tax != total:
            flag('tax_total_mismatch', f'{doc_id}: subtotal plus tax does not equal total.')

    for doc_id, (d, f, rows) in parsed.items():
        kind = d['doc_type']
        if kind in ('opening_trial_balance', 'memo', 'vendor_statement', 'secondary_copy', 'cancellation_note'):
            continue
        if kind == 'customer_invoice':
            if f['Invoice Number'] in withdrawn:
                continue
            total = amount(f['Total'])
            check_document(doc_id, f, rows, total)
            tax = amount(f.get('Tax Amount', '0'))
            if tax:
                if 'Sales Tax Payable' not in allowed:
                    raise ValueError('No output tax account for this packet')
                entries.append(([doc_id], 'Accounts Receivable', revenue[0], amount(f['Subtotal'])))
                entries.append(([doc_id], 'Accounts Receivable', 'Sales Tax Payable', tax))
            else:
                entries.append(([doc_id], 'Accounts Receivable', revenue[0], total))
        elif kind == 'patient_invoice':
            gross = amount(f['Gross Charge'])
            if 'Patient Due' in f and 'Insurer Due' in f and amount(f['Patient Due']) + amount(f['Insurer Due']) != gross:
                flag('invoice_total_mismatch', f'{doc_id}: patient and insurer shares do not equal the gross charge.')
            entries.append(([doc_id], 'Accounts Receivable', revenue[0], gross))
        elif kind == 'rent_roll':
            total = amount(f['Total Rent'])
            check_document(doc_id, f, rows, total)
            entries.append(([doc_id], 'Accounts Receivable', revenue[0], total))
        elif kind in ('vendor_invoice', 'supplier_invoice'):
            if f['Invoice Number'] in withdrawn:
                continue
            expense = f.get('Expense Label')
            if expense not in allowed:
                raise ValueError(f'{doc_id}: expense label {expense!r} is not an allowed account')
            total = amount(f['Total'])
            check_document(doc_id, f, rows, total)
            tax = amount(f.get('Tax Amount', '0'))
            if tax and recoverable:
                entries.append(([doc_id], expense, 'Accounts Payable', amount(f['Subtotal'])))
                entries.append(([doc_id], 'Input Tax Receivable', 'Accounts Payable', tax))
            else:
                entries.append(([doc_id], expense, 'Accounts Payable', total))
        elif kind == 'expense_receipt':
            total = amount(f['Total'])
            check_document(doc_id, f, rows, total)
            expense = next((r['Description'] for r in rows if r.get('Description') in allowed and types.get(r['Description']) == 'expense'), None)
            if expense is None:
                raise ValueError(f'{doc_id}: no receipt line names an allowed expense account')
            entries.append(([doc_id], expense, 'Cash', total))
        elif kind == 'payment_advice':
            target = by_number.get(f.get('Reference'))
            if target is None:
                raise ValueError(f'{doc_id}: payment reference {f.get("Reference")!r} matches no invoice')
            purpose = f.get('Payment For', '').lower()
            if purpose == 'customer settlement':
                entries.append(([doc_id, target], 'Cash', 'Accounts Receivable', amount(f['Amount'])))
            elif purpose == 'supplier settlement':
                entries.append(([doc_id, target], 'Accounts Payable', 'Cash', amount(f['Amount'])))
            else:
                raise ValueError(f'{doc_id}: unsupported payment purpose {purpose!r}')
        elif kind == 'bank_statement':
            balance = amount(f['Opening Balance'])
            for r in rows:
                balance += amount(r['Amount'])
                if 'Running Balance' in r and amount(r['Running Balance']) != balance:
                    flag('bank_closing_mismatch', f'{doc_id}: running balance does not follow the listed movements.')
            if balance != amount(f['Closing Balance']):
                flag('bank_closing_mismatch', f'{doc_id}: opening balance plus movements does not equal the closing balance.')
        else:
            raise ValueError(f'No deterministic procedure for document type {kind}')
    empty = {'assets': {}, 'liabilities': {}, 'equity': {}}
    if issues:
        return json.dumps({'has_inconsistency': True, 'inconsistency_codes': [c for c, _ in issues], 'inconsistency_notes': [n for _, n in issues], 'entries': [], 'balance_sheet': empty})
    out = [{'doc_refs': refs, 'debit_account': dr, 'credit_account': cr, 'amount': float(value)} for refs, dr, cr, value in entries]
    unknown = sorted({a for e in out for a in (e['debit_account'], e['credit_account']) if a not in allowed})
    if unknown:
        raise ValueError(f'Procedure produced accounts outside the allowed list: {unknown}')
    sheet = ledger_balance_sheet(ctx['opening_balance'], out, types, ctx['period_end'])
    return json.dumps({'has_inconsistency': False, 'inconsistency_codes': [], 'inconsistency_notes': [], 'entries': out, 'balance_sheet': sheet})
