"""Evaluation-only helpers. No extraction reasoning, accounting mutations, or model calls."""
from __future__ import annotations
import base64, csv, hashlib, io, json, mimetypes, subprocess
from collections import Counter
from decimal import Decimal, InvalidOperation
from pathlib import Path

PIN = 'b8cb58ff9747486e86c623e867b76fad5d8d075f'
SCORER_SHA256 = 'b4a9187f94fc12995883e0305631ac29931f9781eea4a8c543c807fe32eca2aa'
README_SHA256 = 'c14e9c0609ab3667f3ba4305e5b7a4ba577bacaa56aada633e842e7010003ae8'
ROOT = Path(__file__).resolve().parents[2]
FROZEN = '357866ec73dd8a643408e4a3b1ca4db6654e99b7'

def digest(data: bytes) -> str: return hashlib.sha256(data).hexdigest()
def write_json(path: Path, value): path.write_text(json.dumps(value, indent=2, sort_keys=True)+'\n', encoding='utf-8')
def read_json(path: Path): return json.loads(path.read_text(encoding='utf-8'))
def canonical_hash(value): return digest(json.dumps(value,sort_keys=True,separators=(',',':')).encode())
def git_head(root: Path): return subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD'],text=True).strip()
def source_identity():
    return {'commit':git_head(ROOT),'dirty':bool(subprocess.check_output(['git','-C',str(ROOT),'status','--porcelain'],text=True).strip()),'protocolCommit':FROZEN,'protocolSha256':digest((ROOT/'docs/invoice-mvp/evaluation-protocol.md').read_bytes())}

def verify_upstream(upstream: Path):
    if git_head(upstream) != PIN: raise ValueError('Wrong upstream revision')
    for rel, expected in [('README.md',README_SHA256),('scripts/score_submission.py',SCORER_SHA256)]:
        if digest((upstream/rel).read_bytes()) != expected: raise ValueError('Modified pinned upstream '+rel)
    frozen=read_json(Path(__file__).with_name('upstream-manifest.json'))
    actual={p.relative_to(upstream/'gold_master').as_posix():digest(p.read_bytes()) for p in sorted((upstream/'gold_master').rglob('*')) if p.is_file()}
    if actual != frozen['files']: raise ValueError('Original upstream fixture changed')
    # Check grading data against the pinned Git objects without exposing it to the app.
    for rel in ['answer_key/customer_totals.csv','answer_key/invoices.csv','answer_key/traps.json']:
        original=subprocess.check_output(['git','-C',str(upstream),'show',f'{PIN}:{rel}'])
        if digest(original)!=digest((upstream/rel).read_bytes()): raise ValueError('Modified private grading key')
    return {'commit':PIN,'scorerSha256':SCORER_SHA256,'workspaceTreeSha256':canonical_hash(actual),'workspaceFileCount':len(actual)}

def prepare_workspace(workspace: Path, text_cache: Path):
    """Only source data; no invoice/customer interpretation. Reject links and private paths."""
    root=workspace.resolve(); docs=[]; manifest=[]
    for p in sorted(workspace.rglob('*')):
        if p.is_symlink(): raise ValueError('Symlinks not permitted in evaluation sources')
        if not p.is_file(): continue
        rel=p.relative_to(workspace).as_posix()
        if any(x in {'answer_key','scripts','.git'} for x in p.relative_to(workspace).parts): raise ValueError('Private path in workspace')
        if not p.resolve().is_relative_to(root): raise ValueError('Path escape')
        raw=p.read_bytes()
        if p.suffix.lower()=='.pdf':
            cached=text_cache/(rel+'.txt')
            if cached.is_symlink() or not cached.resolve().is_relative_to(text_cache.resolve()): raise ValueError('Text-cache escape')
            text=cached.read_text(encoding='utf-8')
            extracted=read_json(text_cache/'_manifest.json').get(rel)
            if not extracted or extracted['sha256']!=digest(text.encode()): raise ValueError('PDF text cache differs from extraction manifest')
        else: text=raw.decode('utf-8').replace('\r\n','\n')
        docs.append({'externalId':rel,'name':rel,'mimeType':mimetypes.guess_type(rel)[0] or 'text/plain','text':text,'contentBase64':base64.b64encode(raw).decode()})
        manifest.append({'path':rel,'bytes':len(raw),'byteSha256':digest(raw),'textSha256':digest(text.encode()),'textChars':len(text)})
    return docs,manifest

def money(cents):
    if type(cents) is not int: raise ValueError('Persisted money must be integer cents')
    return f'{Decimal(cents)/100:.2f}'

def export_submission(snapshot, destination: Path):
    """Export persisted totals without filling customers or recalculating app answers."""
    totals=snapshot['customerTotals']; ids=[r['customerId'] for r in totals]
    if len(ids)!=len(set(ids)): raise ValueError('Duplicate customer rows in application snapshot')
    with destination.open('w',newline='',encoding='utf-8') as f:
        w=csv.writer(f); w.writerow(['customer_id','customer_name','valid_invoice_count','gross_invoice_spend_usd','credit_memo_total_usd','net_spend_usd'])
        for r in sorted(totals,key=lambda x:x['customerId']):
            w.writerow([r['customerId'],r['legalName'],r['validInvoiceCount'],money(r['grossCents']),money(r['creditCents']),money(r['netCents'])])

def stable_state(snapshot,details):
    """State that must survive restart; ignore runtime identity and audit additions."""
    return {'runId':snapshot['runId'],'cases':sorted([{k:v for k,v in c.items() if k not in {'updatedAt'}} for c in snapshot['cases']],key=lambda c:c['caseId']), 'customerTotals':sorted(snapshot['customerTotals'],key=lambda r:r['customerId']), 'decisions':sorted([d for detail in details for d in detail['decisions']],key=lambda d:d['decisionId'])}

def audit_state(snapshot, details, imported_ids):
    cases=snapshot['cases']; by_case={d['case']['caseId']:d for d in details}
    current=[c for c in cases if c['status']!='superseded']; observed={c['externalId'] for c in cases}
    sources={(s['documentId'],s['version'],s['contentHash']):s for d in details for s in d['sourceVersions']}
    active=[c for t in snapshot['customerTotals'] for c in t['contributions'] if c['active']]
    duplicate_effects=sum(v-1 for v in Counter(c['documentId'] for c in active).values() if v>1)
    unsupported=[]; aggregate_mismatches=[]
    for contribution in active:
        reasons=[]; d=by_case.get(contribution['caseId']); p=d.get('acceptedProposal') if d else None
        if not d or d['case']['status']!='recorded': reasons.append('effect without recorded case')
        if not p or p['proposalId']!=contribution['proposalId']: reasons.append('effect without matching accepted proposal')
        if p:
            c=p['conclusion']; expected_kind='invoice' if c['treatment']=='include_invoice' else 'credit' if c['treatment']=='include_credit' else None
            if (expected_kind,c.get('customerId'),c.get('documentNumber'),c.get('amountCents'))!=(contribution['kind'],contribution['customerId'],contribution['documentNumber'],contribution['amountCents']): reasons.append('effect differs from accepted conclusion')
        if not contribution['evidence']: reasons.append('no evidence')
        for ref in contribution['evidence']:
            src=sources.get((ref['documentId'],ref['version'],ref['contentHash']))
            if not src: reasons.append('missing evidence version')
            elif 'quote' in ref and ref['quote'] not in src['text']: reasons.append('quote absent from source')
        if reasons: unsupported.append({'caseId':contribution['caseId'],'reasons':reasons})
    for t in snapshot['customerTotals']:
        effects=[c for c in t['contributions'] if c['active']]; inv=[c for c in effects if c['kind']=='invoice']; credits=[c for c in effects if c['kind']=='credit']
        gross=sum(c['amountCents'] for c in inv); credit=sum(c['amountCents'] for c in credits)
        if (len(inv),gross,credit,gross-credit)!=(t['validInvoiceCount'],t['grossCents'],t['creditCents'],t['netCents']): aggregate_mismatches.append(t['customerId'])
    decisions={d['decisionId']:d for detail in details for d in detail['decisions']}
    tools={a['auditId']:a['toolCall'] for detail in details for a in detail['audit'] if 'toolCall' in a}
    unresolved=[c for c in current if c['status'] in {'received','investigating','needs_review','evidence_missing'}]
    mode=snapshot['runtimeMode']
    usage={'toolCalls':len(tools),'modelCalls':None,'inputTokens':None,'outputTokens':None,'cacheReadTokens':None,'cacheWriteTokens':None,'costUsd':None,'coverage':'not exposed as model-call ledger by contract'}
    if mode=='deterministic': usage.update(modelCalls=0,inputTokens=0,outputTokens=0,cacheReadTokens=0,cacheWriteTokens=0,costUsd=0,coverage='runtime explicitly deterministic')
    else:
        # Partial values are diagnostics; never equate tool records with complete model-call accounting.
        usage['partialToolUsage']={k:sum(t.get(k,0) for t in tools.values()) for k in ['inputTokens','outputTokens','costMicros']}
    return {'sourceCount':len(imported_ids),'visibleSourceCount':len(observed),'missingSourceIds':sorted(set(imported_ids)-observed),'unexpectedSourceIds':sorted(observed-set(imported_ids)), 'statusCounts':dict(Counter(c['status'] for c in current)),'unresolvedCases':len(unresolved),'humanInterventions':len(decisions),'duplicateAccountingEffects':duplicate_effects,'unsupportedAcceptedEffectsStructural':len(unsupported),'unsupportedDetail':unsupported,'semanticSupport':'requires original-key/private-suite or independent manual audit; valid references alone do not prove a claim','aggregateMismatchCustomers':aggregate_mismatches,'usage':usage}

def parse_money(value):
    try: return Decimal(str(value).strip().replace('$','').replace(',','')).quantize(Decimal('.01'))
    except (InvalidOperation,ValueError): return None

def strict_customer_metrics(submission: Path, expected: Path):
    def rows(p):
        with p.open(newline='',encoding='utf-8-sig') as f: return list(csv.DictReader(f))
    actual=rows(submission); target=rows(expected); ids=[r.get('customer_id','').strip() for r in actual]
    by_id={r.get('customer_id','').strip():r for r in actual}; target_ids={r['customer_id'].strip() for r in target}
    fields=['valid_invoice_count','gross_invoice_spend_usd','credit_memo_total_usd','net_spend_usd']; exact=Counter(); all_exact=0
    for exp in target:
        act=by_id.get(exp['customer_id'],{}); matches=[]
        for field in fields:
            if field=='valid_invoice_count':
                try: ok=int(act.get(field,''))==int(exp[field])
                except ValueError: ok=False
            else:
                a,e=parse_money(act.get(field,'')),parse_money(exp[field]); ok=a is not None and e is not None and a.is_finite() and a==e
            exact[field]+=int(ok); matches.append(ok)
        all_exact+=int(all(matches))
    dup=sum(n-1 for key,n in Counter(ids).items() if key and n>1)
    return {'customers':len(target),'allFourFieldsExactCents':all_exact,'perFieldExactCents':dict(exact),'duplicateCustomerRows':dup,'blankCustomerRows':ids.count(''),'unexpectedCustomers':sorted(set(ids)-target_ids-{''}),'missingCustomers':sorted(target_ids-set(ids)),'strictPass':all_exact==len(target) and not dup and not ids.count('') and set(ids)==target_ids}

def seal(directory: Path):
    files={p.relative_to(directory).as_posix():digest(p.read_bytes()) for p in sorted(directory.rglob('*')) if p.is_file() and p.name!='artifact-manifest.json'}
    write_json(directory/'artifact-manifest.json',{'files':files,'treeSha256':canonical_hash(files)})

def verify_seal(directory: Path):
    recorded=read_json(directory/'artifact-manifest.json')['files']
    actual={p.relative_to(directory).as_posix():digest(p.read_bytes()) for p in sorted(directory.rglob('*')) if p.is_file() and p.name!='artifact-manifest.json'}
    if actual!=recorded: raise ValueError('Run artifacts changed after recording')


def audit_source_preservation(documents, details):
    """Compare immutable persisted source versions with actual imported bytes/text.

    This is a retention audit, not accounting accuracy or model evaluation.
    """
    expected={}
    for source in documents:
        raw=base64.b64decode(source['contentBase64'],validate=True) if 'contentBase64' in source else source['text'].encode()
        expected[(source['externalId'],digest(raw))]={'textSha256':digest(source['text'].encode()),'originalRequired':'contentBase64' in source}
    observed={}; repeated_versions={}; errors=[]
    for detail in details:
        for source in detail['sourceVersions']:
            identity=(source['documentId'],source['version'])
            fingerprint=canonical_hash({k:source.get(k) for k in ['externalId','contentHash','text','contentBase64']})
            if identity in repeated_versions and repeated_versions[identity]!=fingerprint:
                errors.append({'externalId':source['externalId'],'error':'inconsistent_immutable_version'})
            repeated_versions[identity]=fingerprint
            observed[(source['externalId'],source['contentHash'])]=source
    for key,source in observed.items():
        target=expected.get(key)
        if target is None: continue
        if target['originalRequired'] and 'contentBase64' not in source:
            errors.append({'externalId':source['externalId'],'error':'original_bytes_missing'})
        try: raw=base64.b64decode(source['contentBase64'],validate=True) if 'contentBase64' in source else source['text'].encode()
        except (ValueError,TypeError): errors.append({'externalId':source['externalId'],'error':'invalid_original_encoding'}); continue
        if digest(raw)!=source['contentHash']: errors.append({'externalId':source['externalId'],'error':'stored_content_hash_mismatch'})
        if digest(source['text'].encode())!=target['textSha256']: errors.append({'externalId':source['externalId'],'error':'extracted_text_mismatch'})
    missing=sorted(set(expected)-set(observed)); unexpected=sorted(set(observed)-set(expected))
    return {'expectedSourceVersions':len(expected),'observedSourceVersions':len(observed),'missingVersions':len(missing),'unexpectedVersions':len(unexpected),'retentionErrors':len(errors),'pass':not missing and not unexpected and not errors,'detail':errors,'missingExternalIds':[x[0] for x in missing],'unexpectedExternalIds':[x[0] for x in unexpected]}
