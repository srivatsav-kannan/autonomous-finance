from pathlib import Path
import json, subprocess, sys
b=Path(__file__).resolve().parent
source=Path('/Users/junjiexiong/.ap97-ocr-smoke-6tn3tag/source')
d=['/opt/homebrew/bin/docker','--host','unix:///Users/junjiexiong/.colima/default/docker.sock']
image=(b/'image-id.txt').read_text().strip()
assert image.startswith('sha256:') and len(image)==71
name='ap97-ocr-smoke-6tn3tag-2'
limits=['--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','64','--memory','512m','--cpus','1','--tmpfs','/tmp:rw,noexec,nosuid,size=128m']
def call(label,argv,timeout=30,required=True):
 r=subprocess.run([sys.executable,str(b/'capture.py'),label,str(timeout),*argv])
 if required and r.returncode: raise RuntimeError(label+' failed: '+str(r.returncode))
 return r.returncode
mounts=[]
for rel,target in [('fixtures/ap-system/heldout-suppliers-v1','/fixtures'),('src/ap-system/ingestion/runtime/lock.json','/runtime-lock.json'),('scripts/ap-system/ocr-packaging-smoke.py','/smoke.py')]:
 mounts += ['--mount',f'type=bind,source={source/rel},target={target},readonly']
call('smoke-create-2',d+['create','--name',name,*limits,*mounts,'--entrypoint','python3',image,'/smoke.py','/fixtures','/runtime-lock.json'])
cid=(b/'logs/smoke-create-2.stdout').read_text().strip()
assert len(cid)==64 and all(c in '0123456789abcdef' for c in cid)
try:
 call('smoke-configuration-2',d+['inspect',cid,'--format','{{json .}}'])
 inspect=json.loads((b/'logs/smoke-configuration-2.stdout').read_text()); h=inspect['HostConfig']
 assert h['NetworkMode']=='none' and h['ReadonlyRootfs'] is True and h['CapDrop']==['ALL']
 assert 'no-new-privileges' in h['SecurityOpt'] and h['PidsLimit']==64
 assert h['Memory']==536870912 and h['NanoCpus']==1000000000
 assert h['Tmpfs']['/tmp']=='rw,noexec,nosuid,size=128m'
 assert len(inspect['Mounts'])==3 and all(not m['RW'] for m in inspect['Mounts'])
 code=call('smoke-run-2',d+['start','--attach',cid],timeout=240,required=False)
 call('smoke-state-2',d+['inspect',cid,'--format','{{json .State}}'])
 state=json.loads((b/'logs/smoke-state-2.stdout').read_text())
 assert code==0 and state['ExitCode']==0 and not state['Running'] and not state['OOMKilled'], state
 result=json.loads((b/'logs/smoke-run-2.stdout').read_text())
 assert result['status']=='packaging_smoke_pass' and len(result['results'])==2
 (b/'gate-result.json').write_text(json.dumps({'status':'PASS','imageId':image,'containerId':cid,'state':state,'result':result},indent=2)+'\n')
finally:
 call('smoke-remove-2',d+['rm','--force',cid],required=False)
 call('containers-after-2',d+['ps','-a','--no-trunc','--format','{{.ID}} {{.Image}} {{.Status}}'],required=False)
 call('contexts-after-2', ['/opt/homebrew/bin/docker','context','ls','--format','json'],required=False)
