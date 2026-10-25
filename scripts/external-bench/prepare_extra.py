"""Prepare the opt-in Invoice Sandbox and FinBalance cases from pinned GitHub commits.

Downloads public source archives at fixed commits, verifies pinned content hashes and
separates agent evidence from grading keys. No upstream code is imported or executed:
FinBalance's inconsistency codes and account taxonomy are read with `ast.literal_eval`,
its baseline prompt is ported below (Apache-2.0) and checked line by line against the
pinned source, and Invoice Sandbox's committed fixture is used instead of its generator.
"""
import argparse
import ast
import csv
import hashlib
import io
import json
import re
import shutil
import tarfile
import urllib.request
from pathlib import Path

from prepare import build_database, digest, dump

REPO = Path(__file__).resolve().parents[2]
ARCHIVE_LIMIT = 200_000_000
MEMBER_LIMIT = 50_000_000
EXTRACT_LIMIT = 300_000_000


def archive(source, cache, inventory):
    """A commit-pinned GitHub tarball. Content is verified by the pinned file hashes, not the archive bytes."""
    if not re.fullmatch(r'[0-9a-f]{40}', source['commit']):
        raise ValueError('GitHub sources must be pinned to a full commit SHA')
    dest = cache / 'github' / source['repo'].replace('/', '__') / (source['commit'] + '.tar.gz')
    stamp = dest.with_name(dest.name + '.sha256')
    if dest.exists() and stamp.exists() and digest(dest.read_bytes()) == stamp.read_text().strip():
        data = dest.read_bytes()
    else:
        url = f'https://codeload.github.com/{source["repo"]}/tar.gz/{source["commit"]}'
        with urllib.request.urlopen(url, timeout=180) as response:
            data = response.read(ARCHIVE_LIMIT + 1)
        if len(data) > ARCHIVE_LIMIT:
            raise ValueError(f'Unexpectedly large archive: {source["repo"]}')
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        stamp.write_text(digest(data))
    inventory.append({'repo': source['repo'], 'commit': source['commit'], 'path': 'tar.gz', 'sha256': digest(data), 'bytes': len(data)})
    return data


def extract(data, prefixes, destination):
    """Extract only the wanted regular files; never links, special files or traversal paths."""
    shutil.rmtree(destination, ignore_errors=True)
    destination.mkdir(parents=True)
    root, total, files = destination.resolve(), 0, {}
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as tar:
        for item in tar:
            if item.isdir() or item.type == tarfile.XGLTYPE:
                continue
            parts = item.name.split('/', 1)
            if len(parts) != 2:
                continue
            name = parts[1]
            if not any(name == p or name.startswith(p.rstrip('/') + '/') for p in prefixes):
                continue
            if not item.isfile() or item.size > MEMBER_LIMIT:
                raise ValueError(f'Unsafe archive member: {item.name}')
            target = (destination / name).resolve()
            if not target.is_relative_to(root):
                raise ValueError('Archive path escaped its destination')
            total += item.size
            if total > EXTRACT_LIMIT:
                raise ValueError('Archive expanded beyond expected size')
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(tar.extractfile(item).read())
            files[name] = target
    return files


def tree_digest(files, prefix):
    rows = sorted(f'{name}\t{digest(path.read_bytes())}' for name, path in files.items() if name.startswith(prefix))
    if not rows:
        raise ValueError(f'No files under {prefix}')
    return hashlib.sha256('\n'.join(rows).encode()).hexdigest()


def verify(source, files):
    for name, expected in source['pins'].items():
        actual = tree_digest(files, name) if name.endswith('/') else digest(files[name].read_bytes()) if name in files else None
        if actual != expected:
            raise ValueError(f'Pinned content changed: {source["repo"]}@{source["commit"][:7]} {name} ({actual})')


def literal(path, name):
    """Read a top-level literal assignment without importing or executing the module."""
    for node in ast.parse(path.read_text()).body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in node.targets):
            return ast.literal_eval(node.value)
    raise ValueError(f'{name} not found in {path.name}')


# FinBalance baseline prompt (finbalance/benchmark/prompt.py, build_prompt with prompt_variant
# "baseline" and visibility "normal"). Every constant line is checked against the pinned source.
FB_RULES = [
    "You are given a packet of accounting documents for one reporting period.",
    "Read the documents, infer the journal entries, and produce the final balance sheet.",
    "Some packets may contain distractor documents, secondary copies, cancellation notes, statements, or other non-posting paperwork.",
    "A small number of packets may be internally inconsistent and cannot be reconciled into a sound answer.",
    "Some postings require multiple documents together, such as one payment applied across several invoices, inter-bank transfers, or internal reclassification memos.",
    "Some invoices and bills include indirect tax such as sales tax, VAT, or GST.",
    "Packets may contain country-specific tax rules, exemption certificates, and jurisdiction profiles.",
    "Packets may contain ASC 606 bundled contracts where invoice line items do not equal the accounting allocation.",
    "Packets may contain fixed asset disposals, deferred tax from book/tax depreciation differences, lease accounting, or lease modifications.",
    "Some documents may be denominated in a foreign currency while the final answer still needs to be expressed in the functional currency for the record.",
    "",
    "Rules:",
    "- Use only the allowed account names.",
    "- The opening trial balance is starting state only. Do not turn it into journal entries.",
    "- Do not use 'Opening Balance' as an account name.",
    "- Create entries only for period activity and period-end adjustments supported by the documents.",
    "- Some documents are support-only or distractors and should not create entries by themselves.",
    "- One payment document may settle multiple references, and some allocations may be only partial.",
    "- Some cash movements may be transfers between company-controlled bank accounts and should not create revenue or expense.",
    "- Some entries may be internal corrections or reclassifications with no external counterparty.",
    "- Do not fold indirect tax into revenue, inventory, or expense when the document shows tax separately.",
    "- US sales tax on purchases is embedded in the asset, inventory, or expense cost unless a visible support document says otherwise.",
    "- India GST uses CGST plus SGST for same-state transactions and IGST for different-state transactions.",
    "- Exemption certificates can override the default tax treatment when the certificate is valid for the counterparty and period.",
    "- For ASC 606 bundled contracts, use visible SSP rate cards and performance-obligation schedules; invoice line splits may differ from accounting allocation.",
    "- Implementation revenue is released on acceptance when an implementation acceptance memo supports it.",
    "- Platform or subscription revenue is released ratably only when the schedule supports the release amount.",
    "- For fixed asset disposals, compute net book value from original cost less accumulated depreciation, remove both cost and accumulated depreciation, and record proceeds plus gain or loss.",
    "- For deferred tax, use only visible book depreciation, tax depreciation, tax rates, and deferred tax rollforward support.",
    "- For leases, use visible lease agreements, amortization schedules, payment notices, and modification notices for ROU asset, liability, interest, principal, amortization, and remeasurement entries.",
    "- Use the exchange-rate evidence shown in the packet when a document is denominated in a foreign currency.",
    "- Use only visible rates, SSPs, tax rules, schedules, and support documents; do not invent missing exchange rates, tax rates, SSPs, lease rates, or assumptions.",
    "- Return all journal entries and the final balance sheet in the functional currency shown in the record context.",
    "- If the packet is internally inconsistent, set has_inconsistency to true, choose one or more values from inconsistency_codes, explain briefly in inconsistency_notes, and leave entries as [] and balance_sheet sections empty.",
    "- If has_inconsistency is true, inconsistency_codes must contain at least one key from the allowed list below.",
    "- If the packet is reconcilable, set has_inconsistency to false, set inconsistency_codes to [], and provide the full entries and final balance sheet.",
    "- Use only inconsistency codes from the allowed list below. Do not invent new codes.",
    "- Amounts must be JSON numbers, not strings, and must not contain thousands separators.",
    "- Do not round except to cents for final monetary amounts.",
    "- Return strict JSON only. Do not add markdown or prose.",
    "- The top-level JSON must have exactly these keys: has_inconsistency, inconsistency_codes, inconsistency_notes, entries, balance_sheet.",
    "- Each entry must have doc_refs, debit_account, credit_account, and amount.",
    "- doc_refs must list the document ids that support the posting.",
    "- If one posting depends on multiple documents, include all relevant document ids.",
    "- Use the document ids that are primary evidence for the posting; support-only docs may also be included when needed.",
    "- The final balance sheet must balance: assets = liabilities + equity.",
    "- The balance_sheet object must have exactly these keys: assets, liabilities, equity.",
]
FB_SHAPE = [
    "Output JSON shape:", "{", '  "has_inconsistency": false,', '  "inconsistency_codes": [],', '  "inconsistency_notes": [],',
    '  "entries": [', "    {", '      "doc_refs": ["D003"],', '      "debit_account": "Accounts Receivable",',
    '      "credit_account": "Service Revenue",', '      "amount": 1250.0', "    }", "  ],", '  "balance_sheet": {',
    '    "assets": {},', '    "liabilities": {},', '    "equity": {}', "  }", "}", "",
    "Example for an inconsistent packet:", "{", '  "has_inconsistency": true,', '  "inconsistency_codes": ["bank_closing_mismatch"],',
    '  "inconsistency_notes": ["Bank closing balance does not tie to the listed statement rows."],', '  "entries": [],',
    '  "balance_sheet": {', '    "assets": {},', '    "liabilities": {},', '    "equity": {}', "  }", "}", "", "Documents:",
]
FB_CONTEXT_NOTE = "- Some packets may show ISO currency prefixes such as GBP or EUR instead of symbols like $ or £."


def check_prompt_source(prompt_source):
    source = prompt_source.read_text()
    missing = [line for line in FB_RULES + FB_SHAPE + [FB_CONTEXT_NOTE] if line and json.dumps(line)[1:-1] not in source and line not in source]
    if missing:
        raise ValueError(f'FinBalance prompt port differs from the pinned source: {missing[:3]}')


def finbalance_document(document):
    return '\n'.join([
        f'Document ID: {document["doc_id"]}', f'Document Type: {document["doc_type"]}', f'Document Title: {document["title"]}',
        'Document OCR Text:', document['ocr_text'].strip() or '(empty document text)',
    ])


def finbalance_prompt(record, codes):
    meta = record['metadata']
    lines = list(FB_RULES)
    if not record['allowed_accounts']:
        lines.remove('- Use only the allowed account names.')
    lines += [
        '', 'Record context:',
        f'- Record ID: {record["record_id"]}', f'- Industry: {record["industry"]}', f'- Difficulty level: {record["difficulty_level"]}',
        f'- Period: {meta.get("period_label", record["period_end"])}', f'- Period start: {record["period_start"]}',
        f'- Period end: {record["period_end"]}', f'- Entity: {meta.get("entity_name", "Unknown Entity")}',
        f'- Document display currency: {meta.get("currency_code", "USD")} ({meta.get("currency_symbol", "$")})',
        f'- Functional currency for the answer: {meta.get("functional_currency_code", meta.get("currency_code", "USD"))}',
        f'- Document date format: {meta.get("date_format", "YYYY-MM-DD")}',
        f'- Indirect tax regime for this packet: {meta.get("tax_regime", "none")}',
        FB_CONTEXT_NOTE, '',
    ]
    if record['allowed_accounts']:
        lines += ['Allowed account names:', json.dumps(record['allowed_accounts'], indent=2), '']
    lines += ['Allowed inconsistency codes:', json.dumps(codes, indent=2), ''] + FB_SHAPE
    for document in record['documents']:
        lines += [''] + finbalance_document(document).split('\n')
    return '\n'.join(lines).strip() + '\n'


def invoice_task_text():
    # Reuse the existing harness's task statement (README scoring contract and dataset rules).
    source = (REPO / 'evals/external/invoice-sandbox/lib/task.ts').read_text()
    match = re.search(r'export const TASK_TEXT = `([^`]*)`;', source)
    if not match or '${' in match.group(1):
        raise ValueError('Could not read TASK_TEXT from evals/external/invoice-sandbox/lib/task.ts')
    return match.group(1)


INVOICE_CONTRACT = """

ANSWER FORMAT FOR THIS HARNESS
The workspace is the set of public documents returned by list_documents; use their paths (for example "invoices/<file>.pdf" or "crm/customer_master.csv"). PDF text was extracted without OCR; every page is labeled "Page N".
Return plain text containing exactly these two CSV blocks and nothing else:

CUSTOMER TOTALS
customer_id,customer_name,valid_invoice_count,gross_invoice_spend_usd,credit_memo_total_usd,net_spend_usd
(one row per CRM customer)

EXCLUDED OR SUSPICIOUS DOCUMENTS
path,document_id,customer_id,category,treatment,reason
(one row per excluded or suspicious document; quote any cell containing a comma)

The CUSTOMER TOTALS block is scored per customer on net_spend_usd within $0.01, the benchmark's official metric."""


def prepare_invoice(task, source, files, raw, root, gold):
    workspace = {name.removeprefix('gold_master/'): path for name, path in files.items() if name.startswith('gold_master/')}
    db = root / 'public' / task['id'] / 'evidence.sqlite'
    db.parent.mkdir(parents=True, exist_ok=True)
    build_database(workspace, db)
    totals = files['answer_key/customer_totals.csv'].read_text(encoding='utf-8-sig')
    rows = list(csv.DictReader(io.StringIO(totals)))
    gold[task['id']] = {
        'kind': 'customer-net-spend', 'answer': totals,
        'customers': {r['customer_id']: {k: r[k] for k in ('customer_name', 'valid_invoice_count', 'gross_invoice_spend_usd', 'credit_memo_total_usd', 'net_spend_usd')} for r in rows},
    }
    return invoice_task_text() + INVOICE_CONTRACT, db


def prepare_finbalance(task, source, files, raw, root, gold, records, codes, account_types):
    record = records[task['sourceId']]
    meta = record['metadata']
    folder = raw / 'finbalance' / record['record_id']
    shutil.rmtree(folder, ignore_errors=True)
    folder.mkdir(parents=True)
    # Public evidence mirrors what the upstream prompt shows. Document roles, posting labels,
    # scenario notes and every expected_* field stay private.
    context = {
        'record_id': record['record_id'], 'industry': record['industry'], 'difficulty_level': record['difficulty_level'],
        'period_start': record['period_start'], 'period_end': record['period_end'],
        'period_label': meta.get('period_label', record['period_end']), 'entity_name': meta.get('entity_name', 'Unknown Entity'),
        'currency_code': meta.get('currency_code', 'USD'), 'currency_symbol': meta.get('currency_symbol', '$'),
        'currency_format': meta.get('currency_format'),
        'functional_currency_code': meta.get('functional_currency_code', meta.get('currency_code', 'USD')),
        'date_format': meta.get('date_format', 'YYYY-MM-DD'), 'tax_regime': meta.get('tax_regime', 'none'),
        'opening_balance': record['opening_balance'], 'allowed_accounts': record['allowed_accounts'],
        'account_types': account_types, 'inconsistency_codes': codes,
    }
    documents = [{'doc_id': d['doc_id'], 'doc_type': d['doc_type'], 'title': d['title'], 'ocr_text': d['ocr_text']} for d in record['documents']]
    (folder / 'context.json').write_text(json.dumps(context, indent=2, ensure_ascii=False))
    (folder / 'documents.json').write_text(json.dumps(documents, indent=2, ensure_ascii=False))
    evidence = {'context.json': folder / 'context.json', 'documents.json': folder / 'documents.json'}
    for document in documents:
        path = folder / 'documents' / f'{document["doc_id"]}.txt'
        path.parent.mkdir(exist_ok=True)
        path.write_text(finbalance_document(document) + '\n')
        evidence[f'documents/{document["doc_id"]}.txt'] = path
    db = root / 'public' / task['id'] / 'evidence.sqlite'
    db.parent.mkdir(parents=True, exist_ok=True)
    build_database(evidence, db)
    gold[task['id']] = {
        'kind': 'finbalance',
        'answer': json.dumps({'expected_inconsistency': record['expected_inconsistency'], 'expected_inconsistency_codes': record['expected_inconsistency_codes'], 'expected_balance_sheet': record['expected_balance_sheet']}),
        'finbalance': {
            'recordId': record['record_id'], 'periodEnd': record['period_end'],
            'expectedInconsistency': record['expected_inconsistency'], 'expectedCodes': record['expected_inconsistency_codes'],
            'expectedEntries': record['expected_entries'], 'expectedBalanceSheet': record['expected_balance_sheet'],
            'openingBalance': record['opening_balance'], 'accountTypes': account_types, 'inconsistencyCodes': sorted(codes),
        },
    }
    return finbalance_prompt(record, codes), db


def prepare(manifest_path, root):
    manifest = json.loads(manifest_path.read_text())
    root.mkdir(parents=True, exist_ok=True)
    cache, raw = root / 'private' / 'cache', root / 'private' / 'raw'
    inventory, sources = [], {}
    for key, source in manifest['sources'].items():
        files = extract(archive(source, cache, inventory), source['extract'], raw / key)
        verify(source, files)
        sources[key] = files
    fb = sources['finbalance']
    check_prompt_source(fb['finbalance/benchmark/prompt.py'])
    codes = literal(fb['finbalance/inconsistencies.py'], 'INCONSISTENCY_CODE_DETAILS')
    account_types = literal(fb['finbalance/accounts.py'], 'ACCOUNT_TYPES')
    wanted = {t['sourceId'] for t in manifest['tasks'] if t['benchmark'] == 'finbalance'}
    records = {}
    with fb[manifest['sources']['finbalance']['dataset']].open() as stream:
        for line in stream:
            if line.strip():
                record = json.loads(line)
                if record['record_id'] in wanted:
                    records[record['record_id']] = record
    if set(records) != wanted:
        raise ValueError(f'Missing FinBalance records: {sorted(wanted - set(records))}')
    tasks, gold = [], {}
    for task in manifest['tasks']:
        if task['benchmark'] == 'invoice-sandbox':
            prompt, db = prepare_invoice(task, manifest['sources']['invoice-sandbox'], sources['invoice-sandbox'], raw, root, gold)
        elif task['benchmark'] == 'finbalance':
            record = records[task['sourceId']]
            if record['expected_inconsistency'] != (task['answerType'] == 'finbalance-contradiction'):
                raise ValueError(f'{task["id"]}: manifest stratum does not match the record')
            prompt, db = prepare_finbalance(task, manifest['sources']['finbalance'], fb, raw, root, gold, records, codes, account_types)
        else:
            raise ValueError(f'Unknown benchmark {task["benchmark"]}')
        tasks.append({**task, 'prompt': prompt, 'evidence': db.relative_to(root).as_posix(), 'evidenceSha256': digest(db.read_bytes())})
        print(f'Prepared {task["id"]}', flush=True)
    dump(root / 'private' / 'gold.json', gold)
    dump(root / 'tasks.json', {'id': manifest['id'], 'version': manifest['version'], 'tasks': tasks})
    public_sources = {k: {x: y for x, y in v.items() if x != 'extract'} for k, v in manifest['sources'].items()}
    dump(root / 'provenance.json', {'manifestSha256': digest(manifest_path.read_bytes()), 'tasksSha256': digest((root / 'tasks.json').read_bytes()), 'goldSha256': digest((root / 'private' / 'gold.json').read_bytes()), 'sources': public_sources, 'downloads': inventory})
    print(f'Ready: {len(tasks)} tasks in {root}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, default=REPO / 'benchmarks/finance-extra.json')
    parser.add_argument('--data', type=Path, default=REPO / 'var/benchmarks/finance-extra')
    args = parser.parse_args()
    prepare(args.manifest.resolve(), args.data.resolve())
