#!/usr/bin/env python3
"""Reproduce the frozen AP97 build or bounded OCR smoke without overwriting evidence."""
from pathlib import Path
import argparse, hashlib, json, subprocess, sys, time, uuid
b=Path(__file__).resolve().parent
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('action',choices=['smoke','build'],nargs='?',default='smoke')
a=parser.parse_args()
manifest=json.loads((b/'source-manifest.json').read_text())
for f in manifest['files']:
 assert hashlib.sha256((b/'source'/f['path']).read_bytes()).hexdigest()==f['sha256'], f['path']
suffix=uuid.uuid4().hex[:12]
d=['/opt/homebrew/bin/docker','--host','unix:///Users/junjiexiong/.colima/default/docker.sock']
if a.action=='build':
 tag='ap97-ocr-reproduce:'+suffix
 runtime=b/'source/src/ap-system/ingestion/runtime'
 print('Fresh build tag:',tag,flush=True)
 r=subprocess.run(d+['build','--progress','plain','--tag',tag,'--file',str(runtime/'Dockerfile'),str(runtime)],timeout=1200)
 sys.exit(r.returncode)
staged=Path(json.loads((b/'mount-staging.json').read_text())['source'])
for f in manifest['files']:
 assert hashlib.sha256((staged/f['path']).read_bytes()).hexdigest()==f['sha256'], f['path']
cmd=json.loads((b/'logs/smoke-create-2.json').read_text())['argv']
cmd[cmd.index('--name')+1]='ap97-ocr-reproduce-'+suffix
created=subprocess.run(cmd,check=True,capture_output=True,text=True,timeout=30)
cid=created.stdout.strip()
assert len(cid)==64 and all(c in '0123456789abcdef' for c in cid)
code=1
try:
 start=time.monotonic()
 try:
  r=subprocess.run(d+['start','--attach',cid],timeout=240)
  code=r.returncode
 except subprocess.TimeoutExpired:
  code=124
 print('CLI exit:',code,'elapsed seconds:',round(time.monotonic()-start,3),flush=True)
 subprocess.run(d+['inspect',cid,'--format','{{json .State}}'],check=True,timeout=30)
finally:
 subprocess.run(d+['rm','--force',cid],check=True,timeout=30)
sys.exit(code)
