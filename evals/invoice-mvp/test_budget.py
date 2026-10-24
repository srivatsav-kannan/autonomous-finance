import concurrent.futures,copy,datetime,json,tempfile,unittest
from pathlib import Path
from budget import Ledger,BudgetExceeded,authorization

class BudgetTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.auth=self.root/'authorization.json';self.path=self.root/'ledger.json'
        self.config={'authorized':True,'approvalReference':'TEST_ONLY_NO_NETWORK','expiresAt':(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(hours=1)).isoformat(),'aggregateMaxCostMicros':30000,'ledgerPath':str(self.path),'runs':{'a':{'kind':'baseline','model':'claude-opus-5-5','maxCostMicros':30000,'maxCalls':10,'maxInputTokens':500,'maxOutputTokens':500,'inputMicros':10,'outputMicros':50,'timeoutSeconds':10}}}
        self.config['pricingProvenance']=json.loads(Path(__file__).with_name('pricing-provenance.json').read_text())
        self.save();self.ledger=Ledger(self.path,self.auth)
    def tearDown(self):self.temp.cleanup()
    def save(self):self.auth.write_text(json.dumps(self.config))
    def test_unapproved_and_expired_fail_closed(self):
        self.config['authorized']=False;self.save()
        with self.assertRaises(ValueError):self.ledger.reserve('a','1',10,10)
        self.config['authorized']=True;self.config['expiresAt']='2020-01-01T00:00:00Z';self.save()
        with self.assertRaises(ValueError):authorization(self.auth)
    def test_aggregate_envelopes_and_fixed_ledger(self):
        self.config['runs']['b']=copy.deepcopy(self.config['runs']['a']);self.save()
        with self.assertRaises(BudgetExceeded):authorization(self.auth)
        del self.config['runs']['b'];self.save()
        with self.assertRaises(ValueError):Ledger(self.root/'other.json',self.auth).reserve('a','1',10,10)
    def test_atomic_concurrent_reservation(self):
        def reserve(i):
            try:Ledger(self.path,self.auth).reserve('a',str(i),300,300);return True
            except BudgetExceeded:return False
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:results=list(pool.map(reserve,range(4)))
        self.assertEqual(sum(results),1)
    def test_crash_reservation_and_replay_stay_charged(self):
        self.ledger.reserve('a','1',300,300)
        with self.assertRaises(BudgetExceeded):Ledger(self.path,self.auth).reserve('a','2',300,300)
        with self.assertRaises(BudgetExceeded):self.ledger.reserve('a','1',1,1)
    def test_actual_usage_reconciles_only_after_bounded_success(self):
        self.ledger.reserve('a','1',300,300);self.ledger.settle('a','1',{'model':'claude-opus-5-5','inputTokens':20,'outputTokens':20,'cacheReadTokens':0,'cacheWriteTokens':0})
        self.ledger.reserve('a','2',300,300)
        self.assertEqual(json.loads(self.path.read_text())['runs']['a']['requests']['1']['chargedCostMicros'],1200)
    def test_wrong_model_halts_batch_and_retains_reservation(self):
        self.ledger.reserve('a','1',10,10)
        with self.assertRaises(BudgetExceeded):self.ledger.settle('a','1',{'model':'wrong','inputTokens':1,'outputTokens':1,'cacheReadTokens':0,'cacheWriteTokens':0})
        self.assertTrue(json.loads(self.path.read_text())['halted'])
        with self.assertRaises(BudgetExceeded):self.ledger.reserve('a','2',1,1)
    def test_application_envelope_cannot_be_reused(self):
        self.config['runs']['a']['kind']='application';self.config['pricingProvenance']=json.loads(Path(__file__).with_name('pricing-provenance.json').read_text())
        self.save();self.ledger.claim_application('a','backend-a')
        with self.assertRaises(BudgetExceeded):self.ledger.claim_application('a','backend-b')

if __name__=='__main__':unittest.main()
