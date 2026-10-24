#!/usr/bin/env python3
"""Opt-in application evaluation using real runtime telemetry and prepaid envelopes.

No model client exists here: all inference is through the actual product runtime.
"""
from __future__ import annotations
import argparse,datetime,json,re,sys,time
from pathlib import Path
from budget import Ledger,authorization
from core import *
from http_app import AppClient,chunks
from run import input_data,exclusive,now

def verify_live_runtime(runtime,snapshot,approved,app_commit):
    if runtime.get('mode')!='live_model' or snapshot.get('runtimeMode')!='live_model': raise ValueError('Both runtime and workspace must attest live_model')
    if runtime.get('sourceCommit')!=app_commit or runtime.get('dirty') is not False: raise ValueError('Require exact clean application commit')
    if runtime.get('model')!=approved['model'] or runtime.get('fallbacks') is not False or runtime.get('retries')!=0: raise ValueError('Model mismatch, fallback or retry configuration refused')
    provider=runtime.get('modelProvider') or {}
    if provider.get('baseURL')!='https://api.anthropic.com' or provider.get('authentication')!='explicit_api_key' or provider.get('servedModelValidated') is not True or provider.get('cacheUsageValidated') is not True: raise ValueError('Verified first-party provider/model/cache contract required')
    if provider.get('pricing')!={'inputMicros':approved['inputMicros'],'outputMicros':approved['outputMicros']}: raise ValueError('Runtime pricing differs from approved provider rates')
    if runtime.get('liveExecution')!='requires_explicit_process_opt_in_and_atomic_reservation': raise ValueError('Atomic product budget enforcement not attested')
    budget=runtime.get('budget') or {}; scope=runtime.get('budgetScope') or {}
    for field in ['maxCalls','maxCostMicros','maxInputTokens','maxOutputTokens']:
        if type(budget.get(field)) is not int or budget[field]<=0 or budget[field]>approved[field]: raise ValueError('Product budget exceeds approved '+field)
    if scope.get('maxCalls')!='persistent_run' or scope.get('maxCostMicros')!='persistent_run': raise ValueError('Run budget is not persistent')
    usage=runtime.get('usage') or {}
    if usage.get('available') is not True or usage.get('cache')!='disabled' or usage.get('reservationTool')!='model_reservation' or usage.get('actualUsageTool')!='model_usage': raise ValueError('Complete product telemetry contract required')
    if not runtime.get('promptHash') or not runtime.get('toolsHash'): raise ValueError('Prompt/tool configuration identity required')

def live_usage(details,approved):
    entries={a['auditId']:a.get('toolCall') for d in details for a in d['audit'] if a.get('toolCall')}
    reservations=[c for c in entries.values() if c['tool']=='model_reservation'];actual=[c for c in entries.values() if c['tool']=='model_usage']
    valid=all(c.get('model')==approved['model'] and c.get('mode')=='live_model' and all(type(c.get(k)) is int and c[k]>=0 for k in ['inputTokens','outputTokens','costMicros']) for c in reservations+actual)
    for c in actual:
        if valid and c['costMicros'] != c['inputTokens']*approved['inputMicros']+c['outputTokens']*approved['outputMicros']:valid=False
    reserved_by_id={}
    for call in reservations:
        match=re.search(r'request \(([^)]+)\)',call.get('summary',''))
        if not match or match[1] in reserved_by_id: valid=False
        else: reserved_by_id[match[1]]=call
    observed_ids=set()
    for call in actual:
        match=re.fullmatch(r'Actual provider-reported usage for (?:completed request|unusable response) ([^\s.]+)\.',call.get('summary',''))
        if not match or match[1] not in reserved_by_id or match[1] in observed_ids: valid=False;continue
        observed_ids.add(match[1]);bound=reserved_by_id[match[1]]
        if any(call.get(k,-1)>bound.get(k,-1) for k in ['inputTokens','outputTokens','costMicros']):valid=False
    valid=valid and len(reservations)<=approved['maxCalls'] and sum(c.get('costMicros',0) for c in reservations)<=approved['maxCostMicros']
    complete=valid and len(reservations)==len(actual) and observed_ids==set(reserved_by_id)
    # An interrupted reserved request may have reached the provider. Never infer its usage as zero.
    return {'coverage':'complete_persisted_usage' if complete else 'incomplete_persisted_usage','reservedRequests':len(reservations),'completedRequests':len(actual),'modelCalls':len(actual) if complete else None,'inputTokens':sum(c['inputTokens'] for c in actual) if complete else None,'outputTokens':sum(c['outputTokens'] for c in actual) if complete else None,'costUsd':sum(c['costMicros'] for c in actual)/1e6 if complete else None,'cacheReadTokens':0 if complete else None,'cacheWriteTokens':0 if complete else None,'toolCalls':len(entries),'reservedCostMicros':sum(c.get('costMicros',0) for c in reservations),'errorsOrUnaccountedReservations':not complete}

def live_process_timeout(runtime,approved,elapsed):
    turns=runtime.get('maxTurns')
    if type(turns) is not int or not 1<=turns<=20: raise ValueError('Bounded runtime maxTurns attestation required')
    # One case can make maxTurns sequential 30-second provider requests.
    # Reserve a further minute for local tools/backend work before dispatch.
    allowance=turns*30+60
    if approved['timeoutSeconds']-elapsed < allowance: raise TimeoutError('Insufficient approved wall time for another bounded case')
    return allowance

def execute(args):
    if not args.allow_live: raise ValueError('Live evaluation disabled; explicit --allow-live and recorded authorization required')
    auth=authorization(args.authorization);approved=auth['runs'][args.run_id]
    if approved['kind']!='application':raise ValueError('Approved application envelope required')
    phases,manifest=input_data(args);app=AppClient(args.base_url,args.origin)
    initial=app.workspace();runtime=app.request('runtime');verify_live_runtime(runtime,initial,approved,args.app_commit)
    if initial['cases'] or initial['batches'] or initial['customerTotals']:raise ValueError('Live evaluation requires a fresh empty application workspace')
    exclusive(args.out);Ledger(args.ledger,args.authorization).claim_application(args.run_id,initial['runId'])
    started=time.monotonic();meta={'status':'STARTED','startedAt':now(),'source':source_identity(),'applicationCommitOperatorAttestation':args.app_commit,'cohort':args.cohort,'runtimeMode':'live_model','liveModel':'AUTHORIZED_STARTED','runId':initial['runId'],'command':sys.argv,'authorizationReference':auth['approvalReference'],'runEnvelopeMicros':approved['maxCostMicros'],'aggregateEnvelopeMicros':auth['aggregateMaxCostMicros'],'humanPolicy':'no automatic decisions','restart':'NOT RUN'}
    write_json(args.out/'runtime.json',runtime);write_json(args.out/'initial.json',initial);write_json(args.out/'input-manifest.json',manifest);write_json(args.out/'metadata.json',meta)
    imported=[];final=initial;stop='settled'
    try:
        for n,phase in enumerate(phases):
            if phase.get('requiresRestart'):continue
            stage=args.out/f'phase-{n:02d}';stage.mkdir()
            for j,batch in enumerate(chunks(phase['documents'],args.max_payload_bytes)):
                if time.monotonic()-started>=approved['timeoutSeconds']:raise TimeoutError('Approved wall-time expired')
                result=app.request('batches',{'label':f'live-eval:{args.run_id}:{n}:{j}','documents':batch,'idempotencyKey':f'live-eval:{args.run_id}:{n}:{j}'})
                write_json(stage/f'ingest-{j:03d}.json',result);imported.extend(d['externalId'] for d in batch)
            for iteration in range(args.max_rounds):
                final=app.workspace()
                if not any(c['status'] in {'received','investigating'} for c in final['cases']):break
                if time.monotonic()-started>=approved['timeoutSeconds']:raise TimeoutError('Approved wall-time expired')
                process_timeout=live_process_timeout(runtime,approved,time.monotonic()-started)
                result=app.request('process',{'live':True,'maxCases':1},timeout=process_timeout);write_json(stage/f'process-{iteration:03d}.json',result)
            else:stop='process_round_limit'
            final=app.workspace();detail=app.details(final);write_json(stage/'snapshot.json',final);write_json(stage/'details.json',detail)
            if stop!='settled':break
        final=app.workspace();detail=app.details(final);write_json(args.out/'final.json',final);write_json(args.out/'details.json',detail)
        usage=live_usage(detail,approved);write_json(args.out/'usage.json',usage)
        audit=audit_state(final,detail,imported);audit['usage']=usage;write_json(args.out/'audit.json',audit)
        write_json(args.out/'source-preservation.json',audit_source_preservation([d for p in phases for d in p['documents']],detail));export_submission(final,args.out/'submission.csv')
        # Do not claim a complete live score if provider usage is missing or malformed.
        meta.update(status='RECORDED' if usage['coverage']=='complete_persisted_usage' else 'INCOMPLETE_TELEMETRY',stopReason=stop,liveModel='RUN' if usage['completedRequests'] else 'NO_MODEL_CALLS')
    except Exception as exc:meta.update(status='FAILED',failureType=type(exc).__name__);raise
    finally:meta.update(endedAt=now(),wallSeconds=round(time.monotonic()-started,3));write_json(args.out/'metadata.json',meta);seal(args.out)
    print(meta['status'])

def parser():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--allow-live',action='store_true');p.add_argument('--authorization',type=Path,required=True);p.add_argument('--ledger',type=Path,required=True);p.add_argument('--run-id',required=True);p.add_argument('--app-commit',required=True);p.add_argument('--cohort',choices=['first-pass','post-fix'],required=True)
    p.add_argument('--suite',type=Path);p.add_argument('--upstream',type=Path);p.add_argument('--workspace',type=Path);p.add_argument('--text-cache',type=Path);p.add_argument('--out',type=Path,required=True)
    p.add_argument('--base-url',default='http://127.0.0.1:8790');p.add_argument('--origin',default='http://127.0.0.1:8790');p.add_argument('--max-rounds',type=int,default=200);p.add_argument('--max-payload-bytes',type=int,default=2_000_000)
    return p
if __name__=='__main__':
    try:execute(parser().parse_args())
    except Exception as exc:print(f'{type(exc).__name__}: {exc}',file=sys.stderr);sys.exit(1)
