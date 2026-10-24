#!/usr/bin/env python3
"""Prepare and evaluate through the real invoice MVP service. No model API client."""
from __future__ import annotations
import argparse, datetime, json, subprocess, sys, time
from pathlib import Path
from core import *
from http_app import AppClient, chunks, require_free_runtime

def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
def exclusive(path):
    if path.resolve().is_relative_to(ROOT.resolve()): raise ValueError('Evaluation artifacts must be outside product worktree')
    path.mkdir(parents=True,exist_ok=False)
def input_data(args):
    if args.suite:
        manifest=read_json(Path(__file__).with_name('heldout-manifest.json'))
        if digest(args.suite.read_bytes())!=manifest['sourceSha256']: raise ValueError('Held-out source hash does not match frozen suite')
        suite=read_json(args.suite)
        return suite['phases'],{'kind':'heldout','sourceSha256':manifest['sourceSha256'],'suiteId':suite['suiteId']}
    if not all([args.upstream,args.workspace,args.text_cache]): raise ValueError('Supply upstream, workspace and text-cache')
    verified=verify_upstream(args.upstream)
    # Permit only an original reset workspace, not gold_master or an arbitrary partial subset.
    if args.workspace.resolve().parent.parent != (args.upstream/'runs').resolve() or args.workspace.name!='workspace': raise ValueError('Require upstream runs/<id>/workspace')
    docs,files=prepare_workspace(args.workspace,args.text_cache)
    expected=read_json(Path(__file__).with_name('upstream-manifest.json'))['files']
    if {f['path']:f['byteSha256'] for f in files}!=expected: raise ValueError('Reset workspace differs from pinned fixture')
    return [{'name':'original','documents':docs}],{'kind':'original','upstream':verified,'files':files,'inputSha256':canonical_hash(files)}

def prepare(args):
    phases,manifest=input_data(args); exclusive(args.out)
    write_json(args.out/'input-manifest.json',manifest)
    write_json(args.out/'preparation.json',{'status':'PREPARED_NOT_RUN','source':source_identity(),'documentCount':sum(len(p['documents']) for p in phases),'phases':[{'name':p['name'],'documents':len(p['documents'])} for p in phases],'liveModel':'NOT RUN','application':'NOT RUN','originalScore':'NOT RUN','noApiCalls':True})
    seal(args.out); print('PREPARED_NOT_RUN; no application mutation or model call')

def execute(args):
    phases,manifest=input_data(args); exclusive(args.out)
    started=time.monotonic(); meta={'status':'STARTED','startedAt':now(),'source':source_identity(),'applicationCommitOperatorAttestation':args.app_commit,'command':sys.argv,'cohort':args.cohort,'liveModel':'NOT RUN','humanPolicy':'no automatic decisions','inputSha256':canonical_hash(manifest),'restart':'NOT RUN'}
    write_json(args.out/'metadata.json',meta); write_json(args.out/'input-manifest.json',manifest)
    try:
        app=AppClient(args.base_url,args.origin); initial=app.workspace(); runtime=app.request('runtime'); require_free_runtime(runtime,initial)
        if initial['cases'] or initial['batches'] or initial['customerTotals']: raise ValueError('Application workspace is not fresh and empty')
        if runtime.get('sourceCommit') != args.app_commit: raise ValueError('Runtime source commit differs from operator attestation')
        if runtime.get('dirty') is not False: raise ValueError('Application runtime must attest clean source tree')
        write_json(args.out/'runtime.json',runtime); write_json(args.out/'initial.json',initial)
        imported=[]; final=initial; stop='settled'
        for n,phase in enumerate(phases):
            if phase.get('requiresRestart'):
                meta['restart']='PENDING external process restart and compare-restart command'; continue
            phase_dir=args.out/f'phase-{n:02d}'; phase_dir.mkdir()
            for j,batch in enumerate(chunks(phase['documents'],args.max_payload_bytes)):
                result=app.request('batches',{'label':f'eval:{args.run_id}:{phase["name"]}:{j}','documents':batch,'idempotencyKey':f'eval:{args.run_id}:{n}:{j}'})
                write_json(phase_dir/f'ingest-{j:03d}.json',result); imported.extend(d['externalId'] for d in batch)
            final,checkpoints,stop=app.settle(args.max_rounds); detail=app.details(final)
            write_json(phase_dir/'snapshot.json',final); write_json(phase_dir/'details.json',detail); write_json(phase_dir/'audit.json',audit_state(final,detail,imported))
            if stop!='settled': break
        detail=app.details(final); write_json(args.out/'final.json',final); write_json(args.out/'details.json',detail)
        write_json(args.out/'audit.json',audit_state(final,detail,imported)); export_submission(final,args.out/'submission.csv')
        meta.update(status='RECORDED',stopReason=stop,runId=final['runId'],runtimeMode=final['runtimeMode'],submittedSourceIds=sorted(set(imported)))
    except Exception as exc:
        # Redact message bodies/paths from network errors. Artifacts still preserve partial state.
        meta.update(status='FAILED',failureType=type(exc).__name__,failure=str(exc) if isinstance(exc,ValueError) else type(exc).__name__)
        raise
    finally:
        meta.update(endedAt=now(),wallSeconds=round(time.monotonic()-started,3)); write_json(args.out/'metadata.json',meta); seal(args.out)
    print('RECORDED deterministic application artifacts; scoring is separate')

def restart(args):
    verify_seal(args.before); exclusive(args.out)
    old=read_json(args.before/'final.json'); old_detail=read_json(args.before/'details.json')
    attestation=read_json(args.attestation)
    if attestation.get('gatewayRestarted') is not True or attestation.get('backendRestarted') is not True or not all(attestation.get(k) for k in ['operator','restartedAt','command']): raise ValueError('Actual gateway and backend restart attestation required')
    app=AppClient(args.base_url,args.origin); new=app.workspace(); detail=app.details(new)
    result={'status':'PASS' if stable_state(old,old_detail)==stable_state(new,detail) else 'FAIL','attestation':attestation,'runIdSame':old['runId']==new['runId'],'liveModel':'NOT RUN'}
    write_json(args.out/'restart.json',result); write_json(args.out/'snapshot.json',new); write_json(args.out/'details.json',detail); seal(args.out); print(result['status'])

def parser():
    p=argparse.ArgumentParser(description=__doc__); sub=p.add_subparsers(dest='action',required=True)
    for name in ['prepare','run']:
        q=sub.add_parser(name); q.add_argument('--suite',type=Path); q.add_argument('--upstream',type=Path); q.add_argument('--workspace',type=Path); q.add_argument('--text-cache',type=Path); q.add_argument('--out',type=Path,required=True)
        if name=='run':
            q.add_argument('--run-id',required=True); q.add_argument('--app-commit',required=True); q.add_argument('--cohort',choices=['first-pass','post-fix'],required=True); q.add_argument('--base-url',default='http://127.0.0.1:8790'); q.add_argument('--origin',default='http://127.0.0.1:8790'); q.add_argument('--max-rounds',type=int,default=32); q.add_argument('--max-payload-bytes',type=int,default=2_000_000)
    q=sub.add_parser('compare-restart'); q.add_argument('--before',type=Path,required=True); q.add_argument('--out',type=Path,required=True); q.add_argument('--attestation',type=Path,required=True); q.add_argument('--base-url',default='http://127.0.0.1:8790'); q.add_argument('--origin',default='http://127.0.0.1:8790')
    return p

if __name__=='__main__':
    args=parser().parse_args()
    try: {'prepare':prepare,'run':execute,'compare-restart':restart}[args.action](args)
    except Exception as exc: print(f'{type(exc).__name__}: {exc}',file=sys.stderr); sys.exit(1)
