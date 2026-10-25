"""Offline container smoke gate. Reads fixture manifest/originals, never evaluation facts."""
from pathlib import Path
from PIL import Image
import argparse
import csv
import hashlib
import io
import json
import os
import platform
import re
import subprocess
import tempfile


def sha(data):
    return hashlib.sha256(data).hexdigest()


def run(argv, timeout=20):
    return subprocess.run(argv, check=True, capture_output=True, timeout=timeout).stdout


def inputs(root, lock_file):
    root = root.resolve()
    manifest = json.loads((root / 'manifest.json').read_text())
    lock = json.loads(lock_file.read_text())
    assert manifest['version'] == 'heldout-suppliers-v1', 'unexpected_fixture_version'
    assert lock['engine'] == 'tesseract' and lock['version'] == '5.5.2', 'unexpected_engine'
    assert lock['dpi'] == 144 and lock['psm'] == 6, 'unexpected_ocr_configuration'
    assert 0 < lock['perProcessTimeoutMs'] <= 20000, 'unbounded_timeout'
    sources = manifest['sources']
    assert len(sources) == 4 and len({s['id'] for s in sources}) == 4, 'wrong_original_count'
    assert sum(s['byteLength'] for s in sources) <= 8 * 1024 * 1024, 'packet_too_large'
    selected = []
    for source in sources:
        file = (root / source['path']).resolve()
        assert file.is_relative_to(root / 'input'), 'non_input_path'
        assert source['mimeType'] == 'application/pdf' and source['pages'] == 1, 'unsupported_original'
        assert file.stat().st_size == source['byteLength'], 'original_size_mismatch'
        assert sha(file.read_bytes()) == source['sha256'], 'original_hash_mismatch'
        if source['variant'] == 'scan':
            selected.append((source, file))
    assert len(selected) == 2, 'wrong_scan_count'
    return lock, selected


def main():
    if not __debug__:
        raise RuntimeError('python_optimization_not_supported')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('fixture_root', type=Path)
    parser.add_argument('runtime_lock', type=Path)
    parser.add_argument('--check-inputs-only', action='store_true', help='No renderer or OCR execution')
    args = parser.parse_args()
    lock, selected = inputs(args.fixture_root, args.runtime_lock)
    if args.check_inputs_only:
        print(json.dumps({'status': 'inputs_verified', 'originals': 4, 'scans': len(selected), 'ocrExecuted': False}))
        return
    tess = os.environ.get('AP_TESSERACT', '/usr/local/bin/tesseract')
    tessdata = Path(os.environ.get('AP_TESSDATA_ENG', '/usr/local/share/tessdata/eng.traineddata'))
    assert sha(tessdata.read_bytes()) == lock['traineddata']['sha256'], 'traineddata_hash_mismatch'
    version = run([tess, '--version']).decode().splitlines()[0]
    assert version.strip() == 'tesseract ' + lock['version'], 'tesseract_version_mismatch'
    timeout = lock['perProcessTimeoutMs'] / 1000
    results = []
    with tempfile.TemporaryDirectory(prefix='ap97-ocr-smoke-') as temporary:
        for source, file in selected:
            info = run([os.environ.get('AP_PDFINFO', '/usr/bin/pdfinfo'), str(file)], timeout).decode()
            assert re.search(r'^Pages:\s+1\s*$', info, re.M), 'wrong_page_count'
            assert re.search(r'^Page rot:\s+0\s*$', info, re.M), 'unexpected_rotation'
            size = re.search(r'^Page size:\s+([\d.]+) x ([\d.]+) pts', info, re.M)
            assert size and [float(size[1]), float(size[2])] == [source['frame']['width'], source['frame']['height']], 'frame_mismatch'
            assert not run(['/usr/bin/pdftotext', str(file), '-'], timeout).strip(), 'scan_contains_native_text'
            prefix = Path(temporary) / source['id']
            run([os.environ.get('AP_PDFTOPPM', '/usr/bin/pdftoppm'), '-f', '1', '-l', '1', '-r', str(lock['dpi']), '-singlefile', '-png', str(file), str(prefix)], timeout)
            raster = prefix.with_suffix('.png')
            with Image.open(raster) as image:
                dimensions = list(image.size)
            assert dimensions == [round(source['frame']['width'] * lock['dpi'] / 72), round(source['frame']['height'] * lock['dpi'] / 72)], 'raster_frame_mismatch'
            tsv = run([tess, str(raster), 'stdout', '--tessdata-dir', str(tessdata.parent), '-l', 'eng', '--dpi', str(lock['dpi']), '--psm', str(lock['psm']), 'tsv'], timeout)
            rows = list(csv.DictReader(io.StringIO(tsv.decode()), delimiter='\t'))
            words = [r for r in rows if r.get('level') == '5' and r.get('text', '').strip()]
            assert words, 'no_ocr_words'
            assert {int(r['page_num']) for r in words} == {1}, 'tsv_page_mismatch'
            for word in words:
                x, y, w, h = (int(word[k]) for k in ['left', 'top', 'width', 'height'])
                assert min(x, y) >= 0 and min(w, h) > 0 and x + w <= dimensions[0] and y + h <= dimensions[1], 'tsv_box_outside_frame'
            results.append({'sourceId': source['id'], 'sourceSha256': source['sha256'], 'page': 1, 'rasterDimensions': dimensions, 'rasterSha256': sha(raster.read_bytes()), 'rawTsvSha256': sha(tsv), 'wordCount': len(words)})
    print(json.dumps({'status': 'packaging_smoke_pass', 'architecture': platform.machine(), 'pythonVersion': platform.python_version(), 'tesseract': version, 'traineddataSha256': lock['traineddata']['sha256'], 'results': results, 'accuracyEvaluated': False, 'providerCalls': 0}, indent=2))


if __name__ == '__main__':
    main()
