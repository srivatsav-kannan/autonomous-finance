"""Download pinned public fixtures, separating agent evidence from grading data.

No upstream Python, shell scripts, Docker images or model instructions are executed.
"""
import argparse
import csv
import datetime as dt
import hashlib
import io
import json
import shutil
import sqlite3
import tarfile
import urllib.parse
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def dump(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')


def get(source, name, cache, inventory):
    # Hash every downloaded object; cache content is rechecked on subsequent prepares.
    dest = cache / source['revision'] / name
    stamp = dest.with_name(dest.name + '.sha256')
    if dest.exists() and stamp.exists() and digest(dest.read_bytes()) == stamp.read_text().strip():
        data = dest.read_bytes()
    else:
        url = 'https://huggingface.co/datasets/' + source['repo'] + '/resolve/' + source['revision'] + '/' + urllib.parse.quote(name, safe='/')
        with urllib.request.urlopen(url, timeout=90) as response:
            data = response.read(150_000_001)
        if len(data) > 150_000_000:
            raise ValueError(f'Unexpectedly large source: {name}')
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        stamp.write_text(digest(data))
    inventory.append({'repo': source['repo'], 'revision': source['revision'], 'path': name, 'sha256': digest(data), 'bytes': len(data)})
    return data


def tree(source, prefix):
    url = 'https://huggingface.co/api/datasets/' + source['repo'] + '/tree/' + source['revision'] + '/' + urllib.parse.quote(prefix, safe='/') + '?recursive=true&limit=1000'
    found = []
    while url:
        with urllib.request.urlopen(url, timeout=45) as response:
            found.extend(json.load(response))
            links = response.headers.get('Link', '')
        url = None
        for link in links.split(','):
            if 'rel="next"' in link:
                candidate = link.split('>')[0].strip().lstrip('<')
                if not candidate.startswith('https://huggingface.co/api/'):
                    raise ValueError('Unexpected pagination origin')
                url = candidate
    return [x['path'] for x in found if x['type'] == 'file']


def unpack(data, destination):
    # Never extract links, special files or traversal paths from a downloaded archive.
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        total = 0
        for item in archive:
            if item.isdir():
                continue
            if not item.isfile() or item.size > 50_000_000:
                raise ValueError(f'Unsafe archive member: {item.name}')
            target = (destination / item.name).resolve()
            if not target.is_relative_to(destination.resolve()):
                raise ValueError('Archive path escaped its destination')
            total += item.size
            if total > 300_000_000:
                raise ValueError('Archive expanded beyond expected size')
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.extractfile(item).read())


def scalar(value):
    if isinstance(value, (dt.datetime, dt.date)):
        return value.isoformat()
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, bool):
        return int(value)
    return value


def quote(value):
    return '"' + str(value).replace('"', '""') + '"'


def build_database(files, output):
    """One read-only evidence DB per case. No prompt, solution or rubric tables."""
    if output.exists():
        output.unlink()
    con = sqlite3.connect(output)
    con.execute('CREATE TABLE documents(path TEXT PRIMARY KEY, content TEXT)')
    con.execute('CREATE TABLE table_catalog(name TEXT, path TEXT, sheet TEXT, columns_json TEXT, row_count INTEGER)')
    count = 0

    def add_table(name, sheet, headers, rows):
        nonlocal count
        count += 1
        table = f't{count:03d}'
        seen, columns = set(), []
        for i, h in enumerate(headers):
            base = str(h or f'c{i+1}')
            candidate = base
            while candidate in seen or candidate == '_row':
                candidate += '_'
            seen.add(candidate)
            columns.append(candidate)
        if not columns:
            return
        con.execute(f'CREATE TABLE {table}(_row INTEGER, ' + ','.join(quote(x) for x in columns) + ')')
        n = 0
        for n, row in enumerate(rows, 1):
            values = [scalar(x) for x in row[:len(columns)]]
            values += [None] * (len(columns) - len(values))
            con.execute(f'INSERT INTO {table} VALUES(' + ','.join('?' for _ in range(len(columns)+1)) + ')', [n, *values])
        con.execute('INSERT INTO table_catalog VALUES(?,?,?,?,?)', (table, name, sheet, json.dumps(columns), n))
        return table

    for name, source in sorted(files.items()):
        suffix = source.suffix.lower()
        content = ''
        if suffix == '.xlsx':
            import openpyxl
            values = openpyxl.load_workbook(source, read_only=True, data_only=True)
            formulas = openpyxl.load_workbook(source, read_only=True, data_only=False)
            chunks = []
            for sheet in values:
                rows = list(sheet.values)
                width = max((len(r) for r in rows), default=0)
                # Cell grid preserves title rows, notes, totals and exact source row positions.
                table = add_table(name, sheet.title, [f'c{i+1}' for i in range(width)], rows)
                lines = [f'Sheet: {sheet.title}; SQL table: {table}; c1=A, c2=B, ...; _row=Excel row']
                for i, row in enumerate(rows, 1):
                    if any(x is not None for x in row):
                        lines.append(f'{i}: ' + json.dumps([scalar(x) for x in row], ensure_ascii=False))
                for row in formulas[sheet.title]:
                    for cell in row:
                        if cell.data_type == 'f':
                            lines.append(f'FORMULA {cell.coordinate}: {cell.value}')
                chunks.append('\n'.join(lines))
            values.close()
            formulas.close()
            content = '\n\n'.join(chunks)
        elif suffix == '.csv':
            with source.open(encoding='utf-8-sig', newline='') as stream:
                reader = csv.reader(stream)
                headers = next(reader, [])
                table = add_table(name, '', headers, reader)
            content = f'CSV table: {table}. Query table_catalog for columns and row count.\n' + source.read_text(encoding='utf-8-sig')[:10000]
        elif suffix == '.json':
            content = source.read_text()
            value = json.loads(content)
            if isinstance(value, list) and value and all(isinstance(x, dict) for x in value):
                headers = list(dict.fromkeys(k for row in value for k in row))
                add_table(name, '', headers, ([row.get(h) for h in headers] for row in value))
        elif suffix == '.pdf':
            from pypdf import PdfReader
            reader = PdfReader(source)
            content = '\n\n'.join(f'Page {i+1}\n{p.extract_text() or ""}' for i, p in enumerate(reader.pages))
            if not content.strip() or all(not p.extract_text() for p in reader.pages):
                raise ValueError(f'PDF needs OCR; refusing an empty evidence conversion: {name}')
        elif suffix == '.docx':
            from docx import Document
            doc = Document(source)
            content = '\n'.join(p.text for p in doc.paragraphs)
            for table in doc.tables:
                content += '\n' + '\n'.join('\t'.join(c.text for c in row.cells) for row in table.rows)
        elif suffix in ('.txt', '.md'):
            content = source.read_text(encoding='utf-8-sig')
        else:
            raise ValueError(f'No evidence converter for {name}')
        con.execute('INSERT INTO documents VALUES(?,?)', (name, content))
    con.commit()
    con.close()


def prepare(manifest_path, root):
    manifest = json.loads(manifest_path.read_text())
    root.mkdir(parents=True, exist_ok=True)
    cache, raw = root / 'private' / 'cache', root / 'private' / 'raw'
    inventory = []
    apex = manifest['sources']['apex']
    world = raw / 'apex-world'
    for name in ('filesystem.tar.gz', 'apps_data.tar.gz'):
        destination = world / name.removesuffix('.tar.gz')
        # Rebuild from pinned archives so stale files never survive a prepare.
        shutil.rmtree(destination, ignore_errors=True)
        unpack(get(apex, apex['world']+'/'+name, cache, inventory), destination)
    common = {p.relative_to(world).as_posix(): p for p in world.rglob('*') if p.is_file()}
    dab = manifest['sources']['dabstep']
    dab_files = {}
    for name in tree(dab, 'data/context'):
        file = raw / 'dabstep' / Path(name).name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(get(dab, name, cache, inventory))
        dab_files[file.name] = file
    dev = [json.loads(line) for line in get(dab, 'data/tasks/dev.jsonl', cache, inventory).decode().splitlines() if line.strip()]
    dab_db = root / 'public' / 'dabstep' / 'evidence.sqlite'
    dab_db.parent.mkdir(parents=True, exist_ok=True)
    build_database(dab_files, dab_db)
    tasks, gold = [], {}
    for task in manifest['tasks']:
        if task['benchmark'] == 'apex':
            prefix = 'tasks/' + task['sourceId']
            instruction = get(apex, prefix+'/instruction.md', cache, inventory).decode()
            prompt = instruction.split('\n---\n', 1)[-1].strip()
            files = dict(common)
            for name in tree(apex, prefix+'/environment/task_files'):
                if '/filesystem/' not in name:
                    continue
                file = raw / task['id'] / Path(name).name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(get(apex, name, cache, inventory))
                files['filesystem/'+file.name] = file
            db = root / 'public' / task['id'] / 'evidence.sqlite'
            db.parent.mkdir(parents=True, exist_ok=True)
            build_database(files, db)
            config = json.loads(get(apex, prefix+'/tests/grading_config.json', cache, inventory))
            answer = get(apex, prefix+'/solution/answer.txt', cache, inventory).decode()
            gold[task['id']] = {'kind': 'rubric', 'answer': answer, 'criteria': [{'id': v['verifier_id'], 'description': v['verifier_values']['criteria']} for v in config['verifiers']]}
        else:
            row = next(t for t in dev if str(t['task_id']) == task['sourceId'])
            prompt = row['question'] + '\n\nOutput requirements: ' + row['guidelines']
            db = dab_db
            gold[task['id']] = {'kind': task['answerType'], 'answer': row['answer'], 'decimals': task.get('decimals')}
        tasks.append({**task, 'prompt': prompt, 'evidence': db.relative_to(root).as_posix(), 'evidenceSha256': digest(db.read_bytes())})
        print(f'Prepared {task["id"]}', flush=True)
    # No answer, rubric, private source metadata or source-file hints in the public task list.
    dump(root/'private'/'gold.json', gold)
    dump(root/'tasks.json', {'id': manifest['id'], 'version': manifest['version'], 'tasks': tasks})
    dump(root/'provenance.json', {'manifestSha256': digest(manifest_path.read_bytes()), 'tasksSha256': digest((root/'tasks.json').read_bytes()), 'goldSha256': digest((root/'private'/'gold.json').read_bytes()), 'sources': manifest['sources'], 'downloads': inventory})
    print(f'Ready: {len(tasks)} tasks in {root}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, default=REPO/'benchmarks/finance-eight.json')
    parser.add_argument('--data', type=Path, default=REPO/'var/benchmarks/finance-eight')
    args = parser.parse_args()
    prepare(args.manifest.resolve(), args.data.resolve())
