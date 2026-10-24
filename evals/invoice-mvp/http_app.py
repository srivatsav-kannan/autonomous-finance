"""Real product HTTP boundary. Never imports product internals or invokes a model."""
from __future__ import annotations
import http.cookiejar, json, os, time, urllib.error, urllib.parse, urllib.request

class ApiFailure(RuntimeError):
    def __init__(self,status,code): super().__init__(f'Application HTTP {status}: {code}'); self.status=status; self.code=code

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs): raise ValueError('Application redirects are not permitted')

class AppClient:
    def __init__(self,base='http://127.0.0.1:8790',origin='http://127.0.0.1:8790',timeout=30):
        url=urllib.parse.urlsplit(base)
        if url.scheme!='http' or url.hostname not in {'127.0.0.1','localhost','::1'} or url.username or url.password or url.query or url.fragment or url.path not in {'','/'}: raise ValueError('Use a loopback HTTP application origin')
        self.base=base.rstrip('/'); self.origin=origin; self.timeout=timeout
        self.opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),NoRedirect())
    def request(self,route,body=None,*,timeout=None):
        headers={'Accept':'application/json','Origin':self.origin}
        if body is not None: headers.update({'Content-Type':'application/json','X-Invoice-MVP-Session':'1'})
        req=urllib.request.Request(self.base+'/api/invoice-mvp/'+route,data=None if body is None else json.dumps(body).encode(),headers=headers)
        try:
            with self.opener.open(req,timeout=self.timeout if timeout is None else timeout) as res: value=json.load(res)
        except urllib.error.HTTPError as exc:
            # Do not log arbitrary server bodies; they may include credentials or source text.
            try: code=json.load(exc).get('error',{}).get('code','unknown')
            except (ValueError,AttributeError): code='unknown'
            raise ApiFailure(exc.code,code) from None
        if isinstance(value,dict) and 'error' in value: raise ApiFailure(200,'error_in_success')
        return value
    def workspace(self):
        result=self.request('workspace')
        required={'runId','cases','customerTotals','runtimeMode','progress','currency','batches'}
        if not isinstance(result,dict) or not required<=result.keys() or result['currency']!='USD': raise ValueError('Unexpected WorkspaceSnapshot contract')
        return result
    def details(self,snapshot):
        return [self.request('cases/'+urllib.parse.quote(c['caseId'],safe='')) for c in snapshot['cases']]
    def settle(self,max_rounds=32):
        snapshots=[]
        for _ in range(max_rounds):
            snap=self.workspace(); snapshots.append(snap)
            if not any(c['status'] in {'received','investigating'} for c in snap['cases']): return snap,snapshots,'settled'
            self.request('process',{})
        return self.workspace(),snapshots,'process_round_limit'

# This first release intentionally cannot turn on API use. Read-only runtime attestation
# must confirm deterministic mode before any mutation; live execution is a later gated change.
def require_free_runtime(runtime,snapshot):
    mode=runtime.get('mode',runtime.get('runtimeMode'))
    if mode!='deterministic' or snapshot['runtimeMode']!='deterministic': raise ValueError('Free runner requires attested deterministic runtime; live model execution is disabled')

def chunks(documents,max_bytes=2_000_000):
    current=[]; size=100
    for doc in documents:
        n=len(json.dumps(doc).encode())+2
        if n+100>max_bytes: raise ValueError('Single source exceeds configured HTTP payload cap')
        if current and size+n>max_bytes: yield current; current=[]; size=100
        current.append(doc); size+=n
    if current: yield current
