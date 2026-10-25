"""Read-only agent evidence tools and a deterministic baseline. Never opens gold data."""
import datetime as dt
import json
import math
import re
import sqlite3
import sys
import time
from decimal import Decimal
from pathlib import Path
from apex_rules import ar_reconciliation, payroll_reconciliation
from extra_rules import finbalance_rules, invoice_sandbox_rules


def connect(path):
    db = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    if hasattr(db, 'setlimit'):
        # APEX's extracted journal register exceeds 1 MB. Bound SQL allocations
        # without rejecting legitimate source rows; response limits apply below.
        db.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, 10_000_000)
        db.setlimit(sqlite3.SQLITE_LIMIT_SQL_LENGTH, 12000)
    if hasattr(db, 'enable_load_extension'):
        db.enable_load_extension(False)
    deadline = time.monotonic() + 8
    db.set_progress_handler(lambda: int(time.monotonic() > deadline), 10000)
    # SELECT and built-in arithmetic/JSON functions only; no ATTACH, PRAGMA or writes.
    allowed = {sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ, sqlite3.SQLITE_FUNCTION, sqlite3.SQLITE_RECURSIVE}
    def authorize(action, arg1, arg2, database, trigger):
        if action not in allowed or (action == sqlite3.SQLITE_FUNCTION and str(arg2).lower() in {'load_extension', 'readfile', 'writefile'}):
            return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK
    db.set_authorizer(authorize)
    return db


def query(db, sql):
    if not isinstance(sql, str) or len(sql) > 12000:
        raise ValueError('SQL must be at most 12000 characters')
    cursor = db.execute(sql)
    rows = cursor.fetchmany(201)
    result = {'columns': [x[0] for x in cursor.description], 'rows': [dict(x) for x in rows[:200]], 'truncated': len(rows) > 200}
    # Bound cell payloads as well as row count; an aggregate can return huge strings.
    for row in result['rows']:
        for key, value in row.items():
            if isinstance(value, str) and len(value) > 8000:
                row[key] = value[:8000] + ' [TRUNCATED]'
                result['truncated'] = True
    while len(json.dumps(result)) > 40000 and result['rows']:
        result['rows'].pop()
        result['truncated'] = True
    return result


def document(db, name):
    row = db.execute('SELECT content FROM documents WHERE path=?', (name,)).fetchone()
    if row is None:
        raise ValueError('Unknown document; use list_documents')
    return row[0]


def public_json(db, name):
    return json.loads(document(db, name))


def table_for(db, suffix, sheet=None):
    matches = [dict(x) for x in db.execute('SELECT * FROM table_catalog') if x['path'].endswith(suffix) and (sheet is None or x['sheet'] == sheet)]
    if len(matches) != 1:
        raise ValueError(f'Expected one source table for {suffix}/{sheet}; found {len(matches)}')
    return matches[0]['name']


def wildcard(values, value):
    return values is None or values == [] or value in values


def band(rule, value):
    if rule is None:
        return True
    def number(s):
        factor = 1000000 if s.endswith('m') else 1000 if s.endswith('k') else 1
        return float(s.rstrip('mk%')) * factor
    if rule.startswith('<'):
        return value < number(rule[1:])
    if rule.startswith('>'):
        return value > number(rule[1:])
    a, b = rule.split('-')
    return number(a) <= value <= number(b)


def capture(rule, value):
    if rule is None:
        return True
    if rule in ('manual', 'immediate'):
        return value == rule
    return value.isdigit() and band(rule, int(value))


def fee_matches(fee, merchant, payment, volume, fraud_percent):
    return (
        fee['card_scheme'] == payment['card_scheme']
        and wildcard(fee['account_type'], merchant['account_type'])
        and wildcard(fee['merchant_category_code'], merchant['merchant_category_code'])
        and wildcard(fee['aci'], payment['aci'])
        and capture(fee['capture_delay'], merchant['capture_delay'])
        and band(fee['monthly_volume'], volume)
        and band(fee['monthly_fraud_level'], fraud_percent)
        and (fee['is_credit'] is None or bool(fee['is_credit']) == (payment['is_credit'].lower() == 'true'))
        and (fee['intracountry'] is None or bool(fee['intracountry']) == (payment['issuing_country'] == payment['acquirer_country']))
    )


def dab_rules(db, task_id):
    fees = public_json(db, 'fees.json')
    if task_id in ('dabstep-1273', 'dabstep-1305'):
        selected = [f for f in fees if f['card_scheme'] == 'GlobalCard']
        if task_id == 'dabstep-1273':
            selected = [f for f in selected if f['is_credit'] is None or f['is_credit'] is True]
        else:
            mcc_table = table_for(db, 'merchant_category_codes.csv')
            mcc = db.execute(f'SELECT mcc FROM {mcc_table} WHERE description=?', ('Eating Places and Restaurants',)).fetchone()
            if mcc is None:
                raise ValueError('MCC not found')
            selected = [f for f in selected if wildcard(f['account_type'], 'H') and wildcard(f['merchant_category_code'], int(mcc[0]))]
        if not selected:
            return 'Not Applicable'
        average = sum(Decimal(str(f['fixed_amount'])) + Decimal(str(f['rate'])) * 10 / 10000 for f in selected) / len(selected)
        return f'{average:.6f}'
    merchants = public_json(db, 'merchant_data.json')
    merchant = next(m for m in merchants if m['merchant'] == 'Belles_cookbook_store')
    month = 3 if task_id == 'dabstep-1753' else 1
    table = table_for(db, 'payments.csv')
    payments = [dict(x) for x in db.execute(f'SELECT * FROM {table} WHERE merchant=? AND year=?', (merchant['merchant'], '2023'))
                if (dt.date(2023, 1, 1) + dt.timedelta(days=int(x['day_of_year'])-1)).month == month]
    volume = sum(float(p['eur_amount']) for p in payments)
    fraud = sum(float(p['eur_amount']) for p in payments if p['has_fraudulent_dispute'].lower() == 'true')
    fraud_percent = fraud / volume * 100 if volume else 0
    if task_id == 'dabstep-1681':
        payments = [p for p in payments if int(p['day_of_year']) == 10]
    if task_id == 'dabstep-1871':
        fee = next(f for f in fees if f['ID'] == 384)
        amount = sum((Decimal(p['eur_amount']) for p in payments if fee_matches(fee, merchant, p, volume, fraud_percent)), Decimal(0))
        delta = amount * (Decimal(1) - Decimal(str(fee['rate']))) / 10000
        return f'{delta:.14f}'
    ids = sorted({f['ID'] for p in payments for f in fees if fee_matches(f, merchant, p, volume, fraud_percent)})
    return ', '.join(str(x) for x in ids)


def aging_rules(db):
    # Infer headers from source cells; recompute days past due instead of trusting a supplied bucket.
    tables = [dict(x) for x in db.execute('SELECT * FROM table_catalog') if x['path'].endswith('workpaper_ar_aging_2024_12_31.xlsx')]
    buckets = {'Current': Decimal(0), '1-30': Decimal(0), '31-60': Decimal(0), '61-90': Decimal(0), '>90': Decimal(0)}
    found = False
    for table in tables:
        rows = [dict(x) for x in db.execute(f'SELECT * FROM {table["name"]}')]
        header = next((r for r in rows if any(str(v).lower().strip() == 'due date' for v in r.values())), None)
        if not header:
            continue
        due_col = next(k for k,v in header.items() if str(v).lower().strip() == 'due date')
        balance_col = next((k for k,v in header.items() if re.search(r'(outstanding|open|remaining).*balance|balance.*(due|outstanding)|^(amount|outstanding)$', str(v), re.I)), None)
        if not balance_col:
            raise ValueError('No recognizable invoice balance column')
        for row in rows:
            if row['_row'] <= header['_row'] or row.get(due_col) is None:
                continue
            try:
                due = dt.date.fromisoformat(str(row[due_col])[:10])
                amount = Decimal(str(row[balance_col]))
            except (ValueError, ArithmeticError):
                continue
            days = (dt.date(2024, 12, 31)-due).days
            key = 'Current' if days <= 0 else '1-30' if days <= 30 else '31-60' if days <= 60 else '61-90' if days <= 90 else '>90'
            buckets[key] += amount
            found = True
    total = sum(buckets.values())
    if not found or total <= 0:
        raise ValueError('No positive invoice balances available')
    return '\n'.join(f'{k}: {v/total*100:.2f}%' for k,v in buckets.items())


def handle(db, request):
    op = request['operation']
    if op == 'list':
        return {'documents': [dict(x) for x in db.execute('SELECT path,length(content) AS characters FROM documents')],
                'tables': [dict(x) for x in db.execute('SELECT * FROM table_catalog')]}
    if op == 'read':
        content = document(db, request['path'])
        start = max(0, int(request.get('offset', 0)))
        size = min(16000, max(1, int(request.get('length', 12000))))
        return {'path': request['path'], 'offset': start, 'text': content[start:start+size], 'totalCharacters': len(content), 'nextOffset': start+size if start+size < len(content) else None}
    if op == 'query':
        return query(db, request['sql'])
    if op == 'rules':
        task_id = request['taskId']
        if task_id in ('apex-13', 'apex-17'):
            reconcile = ar_reconciliation if task_id == 'apex-13' else payroll_reconciliation
            return {'status': 'answered', 'answer': reconcile(db)}
        if task_id in {'dabstep-1273', 'dabstep-1305', 'dabstep-1681', 'dabstep-1753', 'dabstep-1871'}:
            return {'status': 'answered', 'answer': dab_rules(db, task_id)}
        if task_id == 'apex-30':
            return {'status': 'answered', 'answer': aging_rules(db)}
        if task_id == 'invoice-sandbox-net-spend':
            return {'status': 'answered', 'answer': invoice_sandbox_rules(db)}
        if task_id.startswith('finbalance-'):
            return {'status': 'answered', 'answer': finbalance_rules(db)}
        return {'status': 'abstained', 'answer': '', 'reason': 'No deterministic reconciliation procedure implemented for this case.'}
    raise ValueError('Unknown evidence operation')


if __name__ == '__main__':
    try:
        result = handle(connect(sys.argv[1]), json.load(sys.stdin))
        print(json.dumps(result, allow_nan=False))
    except Exception as exc:
        print(json.dumps({'error': str(exc)}))
        sys.exit(1)
