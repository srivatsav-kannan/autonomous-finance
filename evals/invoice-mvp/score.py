#!/usr/bin/env python3
"""Evaluator-only grading, after immutable application artifacts exist.

Never import this module into product code. Detailed grading outputs belong
outside product worktrees. Print only aggregate first-pass summaries.
"""
from __future__ import annotations
import argparse,csv,datetime,subprocess,sys
from pathlib import Path
from core import *

def current_details(run):
    return [d for d in read_json(run/'details.json') if d['case']['status']!='superseded']

def document_metrics(run, upstream):
    with (upstream/'answer_key/invoices.csv').open(newline='',encoding='utf-8-sig') as f: key={r['file_path']:r for r in csv.DictReader(f)}
    details={d['case']['externalId']:d for d in current_details(run)}
    results=[]
    for path,exp in key.items():
        detail=details.get(path); effects=[c for c in detail.get('contributions',[]) if c['active']] if detail else []
        expected_kind={'include':'invoice','credit_memo':'credit'}.get(exp['policy']); issue=[]
        if not detail: issue.append('missing_source')
        elif expected_kind:
            if not effects: issue.append('missing_inclusion')
            if detail['case']['status'] in {'excluded','duplicate'}: issue.append('incorrect_exclusion')
            if len(effects)>1: issue.append('duplicate_effect')
            for e in effects:
                if e['kind']!=expected_kind or e['customerId']!=exp['customer_id'] or Decimal(e['amountCents'])/100!=parse_money(exp['total_usd']): issue.append('unsupported_effect')
        elif effects: issue.append('incorrect_inclusion')
        results.append({'path':path,'issues':sorted(set(issue)),'status':detail['case']['status'] if detail else 'missing'})
    # Workspace support files are not invoices, even when no answer-key PDF row exists.
    support_effects=[d['case']['externalId'] for path,d in details.items() if path not in key and any(c['active'] for c in d['contributions'])]
    counts=Counter(issue for row in results for issue in row['issues'])
    return {'scoredDocuments':len(key),'documentsWithoutObservedError':sum(not r['issues'] for r in results),'issueCounts':dict(counts),'supportFilesIncorrectlyIncluded':len(support_effects),'detail':results,'supportEffectPaths':support_effects}

def heldout_metrics(run,expected):
    detail={d['case']['externalId']:d for d in current_details(run)}; rows=[]
    for check in expected['checks']:
        d=detail.get(check['externalId']); failures=[]
        if d is None: failures=['missing_source']
        else:
            effects=[c for c in d['contributions'] if c['active']]; proposal=d.get('currentProposal'); con=proposal.get('conclusion') if proposal else None
            if check.get('mustNotCount') and effects: failures.append('must_not_count')
            if check.get('requiredStatus') and d['case']['status']!=check['requiredStatus']: failures.append('incorrect_status')
            if check.get('requiresReview'):
                if effects: failures.append('unresolved_conflict_counted')
                if d['case']['status'] not in {'needs_review','evidence_missing'}: failures.append('review_not_visible')
                if not (d['case'].get('question') or d['case'].get('contradictions')): failures.append('missing_specific_question_or_contradiction')
            if 'allowedTreatments' in check:
                if con is None: failures.append('no_proposal')
                else:
                    if con['treatment'] not in check['allowedTreatments']: failures.append('incorrect_proposed_treatment')
                    for field in ['customerId','documentNumber','amountCents']:
                        if field in check and con.get(field)!=check[field]: failures.append('incorrect_proposed_'+field)
        rows.append({'checkId':check['id'],'pass':not failures,'failures':failures})
    return {'checks':len(rows),'checksPassed':sum(r['pass'] for r in rows),'detail':rows,'basis':'Autonomous dispositions/proposals; accepted totals separately. Hidden assisted totals are not applied.','restart':'NOT RUN until separate process restart comparison','humanDecisionReplay':'NOT RUN until explicit operator decision test','staleApproval':'NOT RUN until explicit operator decision test'}

def score(args):
    if args.out.resolve().is_relative_to(ROOT.resolve()): raise ValueError('Private grading output must be outside product worktree')
    verify_seal(args.run); meta=read_json(args.run/'metadata.json')
    if meta['status']!='RECORDED': raise ValueError('Only completely recorded application runs can be scored')
    args.out.mkdir(parents=True,exist_ok=False)
    result={'recordedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'runArtifactSha256':digest((args.run/'artifact-manifest.json').read_bytes()),'source':source_identity(),'runMetadata':meta,'runtimeMode':meta['runtimeMode'],'liveModel':'NOT RUN' if meta['runtimeMode']!='live_model' else 'RUN'}
    if args.upstream:
        result['upstream']=verify_upstream(args.upstream)
        completed=subprocess.run([sys.executable,'-I',str(args.upstream/'scripts/score_submission.py'),str((args.run/'submission.csv').resolve())],capture_output=True,text=True,check=True)
        (args.out/'official_score.txt').write_text(completed.stdout)
        official={}
        for line in completed.stdout.splitlines():
            if not line: break
            name,value=line.split(',',1); official[name]=value
        result['official']=official
        result['strictCustomerMetrics']=strict_customer_metrics(args.run/'submission.csv',args.upstream/'answer_key/customer_totals.csv')
        result['documentMetrics']=document_metrics(args.run,args.upstream)
    elif args.expectations:
        frozen=read_json(Path(__file__).with_name('heldout-manifest.json'))
        if digest(args.expectations.read_bytes())!=frozen['expectationsSha256']: raise ValueError('Changed held-out expectations')
        inputs=read_json(args.run/'input-manifest.json')
        if inputs.get('sourceSha256')!=frozen['sourceSha256']: raise ValueError('Run did not use frozen held-out sources')
        result['heldout']=heldout_metrics(args.run,read_json(args.expectations)); result['expectationsSha256']=frozen['expectationsSha256']
    else: raise ValueError('Select original upstream or hidden expectations')
    result['structuralAudit']=read_json(args.run/'audit.json')
    write_json(args.out/'score.json',result); seal(args.out)
    summary={'runtimeMode':result['runtimeMode'],'liveModel':result['liveModel'],'official':result.get('official'),'strictCustomerMetrics':result.get('strictCustomerMetrics'),'heldout':{k:v for k,v in result.get('heldout',{}).items() if k!='detail'},'runArtifactSha256':result['runArtifactSha256'],'scoreJsonSha256':digest((args.out/'score.json').read_bytes())}
    write_json(args.out/'aggregate.json',summary); seal(args.out)
    print(json.dumps(summary,indent=2))

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__); p.add_argument('--run',type=Path,required=True); p.add_argument('--out',type=Path,required=True)
    choice=p.add_mutually_exclusive_group(required=True); choice.add_argument('--upstream',type=Path); choice.add_argument('--expectations',type=Path)
    try: score(p.parse_args())
    except Exception as exc: print(f'{type(exc).__name__}: {exc}',file=sys.stderr);sys.exit(1)
