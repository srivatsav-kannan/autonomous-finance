"""Evaluation-only original integrity/arithmetic check; never imports runtime parser code."""
from pathlib import Path
from decimal import Decimal
from pypdf import PdfReader
import hashlib
import json

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / 'manifest.json').read_text())
expected = json.loads((root / 'evaluation/expected-outcomes.json').read_text())
profiles = expected['profiles']
count = 0
for source in manifest['sources']:
    original = root / source['path']
    assert hashlib.sha256(original.read_bytes()).hexdigest() == source['sha256']
    assert original.stat().st_size == source['byteLength']
    reader = PdfReader(original)
    assert len(reader.pages) == source['pages'] == 1
    page = reader.pages[0]
    assert page.rotation == 0
    assert list(page.mediabox) == [0, 0, source['frame']['width'], source['frame']['height']]
    assert page.cropbox == page.mediabox
    profile = next(p for p in profiles.values() if source['id'] in p['sources'])
    assert profile['frame'] == source['frame']
    assert len(profile['headers']) + len(profile['lines']) * 6 == profile['fieldFactsPerDocument']
    count += profile['fieldFactsPerDocument']
    for row in profile['lines']:
        assert Decimal(row['quantity']) * row['unitPriceCents'] == row['amountCents']
    header = profile['headers']
    assert sum(r['amountCents'] for r in profile['lines']) == header['subtotalCents']
    assert header['subtotalCents'] + header['taxCents'] + header['freightCents'] - header['discountCents'] == header['totalCents']
    content = ' '.join(page.extract_text().split())
    if source['variant'] == 'scan':
        assert not content
        assert len(page.images) == 1
    else:
        assert 'SYNTHETIC TEST DOCUMENT' in content
        for field, value in header.items():
            displayed = f'{Decimal(value)/100:,.2f}' if field.endswith('Cents') else str(value)
            assert displayed in content, (source['id'], field)
        for row in profile['lines']:
            for field, value in row.items():
                displayed = f'{Decimal(value)/100:,.2f}' if field.endswith('Cents') else str(value)
                assert displayed in content, (source['id'], field)
assert count == expected['scoring']['contentFieldDenominator'] == 104
print(json.dumps({'status': 'pass', 'originals': 4, 'nativeOriginals': 2, 'imageOnlyOriginals': 2, 'facts': count, 'parserInvoked': False, 'independentVisualReview': 'pending V'}))
