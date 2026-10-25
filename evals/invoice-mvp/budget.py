"""Persistent, locked prepaid batch/run budgets. This module never uses the network."""
from __future__ import annotations
import contextlib,datetime,fcntl,hashlib,json,os,sys,tempfile
from pathlib import Path

class BudgetExceeded(ValueError): pass

def positive(value): return type(value) is int and value>0

def authorization(path):
    value=json.loads(Path(path).read_text())
    if value.get('authorized') is not True or not value.get('approvalReference'): raise ValueError('Explicit recorded human authorization is required')
    expiry=datetime.datetime.fromisoformat(value['expiresAt'].replace('Z','+00:00'))
    if expiry.tzinfo is None or expiry<=datetime.datetime.now(datetime.timezone.utc): raise ValueError('Authorization expired or lacks timezone')
    if not value.get('ledgerPath') or not Path(value['ledgerPath']).is_absolute(): raise ValueError('One absolute shared ledgerPath is required')
    if not positive(value.get('aggregateMaxCostMicros')) or not value.get('runs'): raise ValueError('Positive aggregate budget and planned runs required')
    records=[json.loads(Path(__file__).with_name(name).read_text()) for name in ['pricing-provenance.json','pricing-provenance.openai.json']]
    provenance=value.get('pricingProvenance')
    if provenance not in records: raise ValueError('Reviewed model/pricing provenance must match committed record')
    verified=datetime.date.fromisoformat(provenance['verifiedDate'])
    if abs((datetime.datetime.now(datetime.timezone.utc).date()-verified).days)>7: raise ValueError('Reverify provider prices before approving this batch')
    for run in value['runs'].values():
        if run.get('kind') not in {'baseline','application'} or not run.get('model'): raise ValueError('Run kind and exact model required')
        if run['model']!=provenance['model'] or run.get('inputMicros',0)<provenance['inputMicrosPerToken'] or run.get('outputMicros',0)<provenance['outputMicrosPerToken']: raise ValueError('Exact verified model and conservative provider prices required')
        if run.get('provider','anthropic')!=provenance.get('providerId','anthropic'): raise ValueError('Provider must match reviewed provenance')
        for key in ['maxCostMicros','maxCalls','maxInputTokens','maxOutputTokens','inputMicros','outputMicros','timeoutSeconds']:
            if not positive(run.get(key)): raise ValueError('Positive integer '+key+' required')
        if run.get('provider')=='openai':
            if run['maxInputTokens']>250000 or run['maxOutputTokens']>128000: raise ValueError('OpenAI short-context/output bounds exceeded')
            if run.get('effort')!='high': raise ValueError('Reviewed OpenAI comparison requires high reasoning effort')
    if sum(r['maxCostMicros'] for r in value['runs'].values())>value['aggregateMaxCostMicros']: raise BudgetExceeded('Planned run envelopes exceed approved aggregate cap')
    return value

class Ledger:
    def __init__(self,path,auth_path): self.path=Path(path);self.auth_path=Path(auth_path)
    @contextlib.contextmanager
    def state(self):
        auth=authorization(self.auth_path)
        if Path(auth['ledgerPath']).resolve()!=self.path.resolve(): raise ValueError('Ledger path differs from approved shared batch ledger')
        identity=hashlib.sha256(json.dumps(auth,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        self.path.parent.mkdir(parents=True,exist_ok=True)
        with os.fdopen(os.open(str(self.path)+'.lock',os.O_CREAT|os.O_RDWR,0o600),'a+') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX)
            state=json.loads(self.path.read_text()) if self.path.exists() else {'authorizationSha256':identity,'runs':{},'halted':False}
            if state['authorizationSha256']!=identity: raise ValueError('Authorization changed; existing prepaid ledger cannot be reset')
            if state['halted']: raise BudgetExceeded('Ledger halted after accounting violation')
            yield state,auth
            fd,temp=tempfile.mkstemp(dir=self.path.parent,prefix='.budget-')
            try:
                with os.fdopen(fd,'w') as stream:json.dump(state,stream,sort_keys=True);stream.flush();os.fsync(stream.fileno())
                os.replace(temp,self.path)
                directory=os.open(self.path.parent,os.O_RDONLY)
                try:os.fsync(directory)
                finally:os.close(directory)
            finally:
                if os.path.exists(temp):os.unlink(temp)
    def reserve(self,run_id,request_id,input_tokens,output_tokens):
        with self.state() as (state,auth):
            config=auth['runs'][run_id]
            if config['kind']!='baseline': raise ValueError('Only baseline uses per-request local reservations')
            if not positive(input_tokens) or not positive(output_tokens) or input_tokens>config['maxInputTokens'] or output_tokens>config['maxOutputTokens']: raise BudgetExceeded('Request token bound exceeds approval')
            run=state['runs'].setdefault(run_id,{'requests':{}}); requests=run['requests']
            if request_id in requests: raise BudgetExceeded('Reservation replay cannot authorize another request')
            cost=input_tokens*config['inputMicros']+output_tokens*config['outputMicros']
            if len(requests)>=config['maxCalls'] or sum(x['chargedCostMicros'] for x in requests.values())+cost>config['maxCostMicros']: raise BudgetExceeded('Pre-request reservation exceeds run cap')
            requests[request_id]={'status':'reserved','inputTokensBound':input_tokens,'outputTokensBound':output_tokens,'reservedCostMicros':cost,'chargedCostMicros':cost}
            return {'reservedCostMicros':cost,'runEnvelopeMicros':config['maxCostMicros'],'aggregateEnvelopeMicros':auth['aggregateMaxCostMicros']}
    def settle(self,run_id,request_id,usage):
        violation=False
        with self.state() as (state,auth):
            config=auth['runs'][run_id];record=state['runs'][run_id]['requests'][request_id]
            if record['status']!='reserved': raise BudgetExceeded('Usage settlement replay refused')
            valid=usage.get('model')==config['model'] and all(type(usage.get(k)) is int and usage[k]>=0 for k in ['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens']) and usage.get('cacheReadTokens')==0 and usage.get('cacheWriteTokens')==0
            if config.get('provider')=='openai':
                valid=valid and usage.get('serviceTier')=='default' and type(usage.get('reasoningTokens')) is int and 0<=usage['reasoningTokens']<=usage['outputTokens']
            cost=(usage.get('inputTokens',0)*config['inputMicros']+usage.get('outputTokens',0)*config['outputMicros']) if valid else record['reservedCostMicros']
            valid=valid and usage['inputTokens']<=record['inputTokensBound'] and usage['outputTokens']<=record['outputTokensBound'] and cost<=record['reservedCostMicros']
            if not valid:
                state['halted']=True;record['status']='usage_violation';violation=True
            else:record.update(status='settled',chargedCostMicros=cost,usage=usage)
        if violation:raise BudgetExceeded('Provider usage/model violates reserved bounds; batch halted')
        return {'costMicros':cost}
    def claim_application(self,run_id,backend_run_id):
        with self.state() as (state,auth):
            config=auth['runs'][run_id]
            if config['kind']!='application': raise ValueError('Not an application envelope')
            if run_id in state['runs']: raise BudgetExceeded('Application envelope already claimed; no automatic restart or reuse')
            state['runs'][run_id]={'status':'claimed','backendRunId':backend_run_id,'chargedCostMicros':config['maxCostMicros']}
            return {'reservedEnvelopeMicros':config['maxCostMicros'],'aggregateEnvelopeMicros':auth['aggregateMaxCostMicros']}

def main():
    request=json.load(sys.stdin);ledger=Ledger(request['ledger'],request['authorization']);action=request['action']
    if action=='reserve': result=ledger.reserve(request['runId'],request['requestId'],request['inputTokens'],request['outputTokens'])
    elif action=='settle': result=ledger.settle(request['runId'],request['requestId'],request['usage'])
    elif action=='claim_application':result=ledger.claim_application(request['runId'],request['backendRunId'])
    else:raise ValueError('Unknown budget action')
    print(json.dumps(result))
if __name__=='__main__':
    try:main()
    except Exception as exc:print(json.dumps({'error':type(exc).__name__,'message':str(exc)}));sys.exit(1)
