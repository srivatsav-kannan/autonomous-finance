import copy,unittest
from live_app import verify_live_runtime,live_usage,execute
from types import SimpleNamespace

class LiveTests(unittest.TestCase):
    def setUp(self):
        self.approved={'model':'claude-opus-5-5','maxCalls':40,'maxCostMicros':3000000,'maxInputTokens':100000,'maxOutputTokens':1200,'inputMicros':4,'outputMicros':20}
        self.runtime={'mode':'live_model','sourceCommit':'exact','dirty':False,'model':'claude-opus-5-5','fallbacks':False,'retries':0,'liveExecution':'requires_explicit_process_opt_in_and_atomic_reservation','budget':{k:v for k,v in self.approved.items() if k.startswith('max')},'budgetScope':{'maxCalls':'persistent_run','maxCostMicros':'persistent_run'},'usage':{'available':True,'cache':'disabled','reservationTool':'model_reservation','actualUsageTool':'model_usage'},'promptHash':'prompt','toolsHash':'tools','modelProvider':{'baseURL':'https://api.anthropic.com','authentication':'explicit_api_key','pricing':{'inputMicros':4,'outputMicros':20},'servedModelValidated':True,'cacheUsageValidated':True}}
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
        actual['toolCall']['model']='wrong';self.assertEqual(live_usage([{'audit':[reservation,actual]}],self.approved)['coverage'],'incomplete_persisted_usage')

if __name__=='__main__':unittest.main()
