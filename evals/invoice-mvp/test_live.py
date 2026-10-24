import copy,io,unittest
from http_app import AppClient
from live_app import verify_live_runtime,live_usage,execute,live_process_timeout
from types import SimpleNamespace

class LiveTests(unittest.TestCase):
    def setUp(self):
        self.approved={'model':'claude-opus-5-5','maxCalls':40,'maxCostMicros':3000000,'maxInputTokens':100000,'maxOutputTokens':1200,'inputMicros':4,'outputMicros':20,'timeoutSeconds':1200}
        self.runtime={'maxTurns':10,'mode':'live_model','sourceCommit':'exact','dirty':False,'model':'claude-opus-5-5','fallbacks':False,'retries':0,'liveExecution':'requires_explicit_process_opt_in_and_atomic_reservation','budget':{k:v for k,v in self.approved.items() if k.startswith('max')},'budgetScope':{'maxCalls':'persistent_run','maxCostMicros':'persistent_run'},'usage':{'available':True,'cache':'disabled','reservationTool':'model_reservation','actualUsageTool':'model_usage'},'promptHash':'prompt','toolsHash':'tools','modelProvider':{'baseURL':'https://api.anthropic.com','authentication':'explicit_api_key','pricing':{'inputMicros':4,'outputMicros':20},'servedModelValidated':True,'cacheUsageValidated':True}}
    def test_missing_opt_in_stops_before_network_or_configuration(self):
        with self.assertRaises(ValueError):execute(SimpleNamespace(allow_live=False))
    def test_accepts_only_real_attested_bounded_live_mode(self):
        verify_live_runtime(self.runtime,{'runtimeMode':'live_model'},self.approved,'exact')
        for change in [{'mode':'mock_model'},{'fallbacks':True},{'retries':1},{'model':'other'},{'dirty':True},{'sourceCommit':'wrong'},{'usage':{'available':False}},{'budget':{}},{'modelProvider':{}},{'modelProvider':{**self.runtime['modelProvider'],'servedModelValidated':False}},{'modelProvider':{**self.runtime['modelProvider'],'pricing':{'inputMicros':1,'outputMicros':1}}}]:
            with self.assertRaises(ValueError):verify_live_runtime({**self.runtime,**change},{'runtimeMode':'live_model'},self.approved,'exact')
    def test_usage_requires_both_reservation_and_actual_evidence(self):
        reservation={'auditId':'r','toolCall':{'tool':'model_reservation','summary':'Reserved one claude-opus-5-5 request (r1); max output 100; no retries or fallback.','mode':'live_model','model':'claude-opus-5-5','inputTokens':100,'outputTokens':100,'costMicros':2400}}
        actual={'auditId':'a','toolCall':{'tool':'model_usage','summary':'Actual provider-reported usage for completed request r1.','mode':'live_model','model':'claude-opus-5-5','inputTokens':10,'outputTokens':10,'costMicros':240}}
        complete=live_usage([{'audit':[reservation,actual]}],self.approved);self.assertEqual(complete['costUsd'],0.00024);self.assertEqual(complete['modelCalls'],1)
        partial=live_usage([{'audit':[reservation]}],self.approved);self.assertIsNone(partial['modelCalls']);self.assertIsNone(partial['costUsd'])
        actual['toolCall']['summary']='Actual provider-reported usage for unusable response r1.'
        self.assertEqual(live_usage([{'audit':[reservation,actual]}],self.approved)['costUsd'],0.00024)
        actual['toolCall']['model']='wrong';self.assertEqual(live_usage([{'audit':[reservation,actual]}],self.approved)['coverage'],'incomplete_persisted_usage')

    def test_openai_runtime_requires_exact_provider_api_cache_tier_and_effort(self):
        approved={**self.approved,'provider':'openai','model':'gpt-6.1-sol','effort':'high','inputMicros':2,'outputMicros':10}
        runtime={**self.runtime,'model':'gpt-6.1-sol','effort':'high','outputTokensPerCall':approved['maxOutputTokens'],'modelProvider':{**self.runtime['modelProvider'],'baseURL':'https://api.openai.com/v1','api':'responses','serviceTier':'default','promptCacheMode':'explicit_without_breakpoints','pricing':{'inputMicros':2,'outputMicros':10}}}
        verify_live_runtime(runtime,{'runtimeMode':'live_model'},approved,'exact')
        for field,bad in [('baseURL','https://example.invalid'),('api','chat_completions'),('serviceTier','fast'),('promptCacheMode','implicit')]:
            changed={**runtime,'modelProvider':{**runtime['modelProvider'],field:bad}}
            with self.assertRaises(ValueError):verify_live_runtime(changed,{'runtimeMode':'live_model'},approved,'exact')
        with self.assertRaises(ValueError):verify_live_runtime({**runtime,'effort':'medium'},{'runtimeMode':'live_model'},approved,'exact')
        with self.assertRaises(ValueError):verify_live_runtime({**runtime,'outputTokensPerCall':100},{'runtimeMode':'live_model'},approved,'exact')

    def test_process_http_timeout_is_explicit_without_changing_read_default(self):
        client=AppClient();timeouts=[]
        def open_without_network(request,timeout):
            timeouts.append(timeout);return io.StringIO('{"ok":true}')
        client.opener=SimpleNamespace(open=open_without_network)
        client.request('process',{'live':True,'maxCases':1},timeout=360)
        client.request('runtime')
        self.assertEqual(timeouts,[360,30])
    def test_process_timeout_allows_full_case_and_respects_deadline(self):
        self.assertEqual(live_process_timeout(self.runtime,self.approved,0),360)
        self.assertEqual(live_process_timeout(self.runtime,self.approved,840),360)
        with self.assertRaises(TimeoutError):live_process_timeout(self.runtime,self.approved,841)
        with self.assertRaises(ValueError):live_process_timeout({**self.runtime,'maxTurns':21},self.approved,0)

if __name__=='__main__':unittest.main()
