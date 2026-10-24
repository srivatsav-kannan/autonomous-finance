"""Mock endpoint tests are adapter tests, never application acceptance."""
import copy,csv,json,os,subprocess,sys,tempfile,threading,unittest
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from core import audit_state,export_submission,prepare_workspace,seal,strict_customer_metrics,verify_seal
from http_app import AppClient,ApiFailure,chunks,require_free_runtime

class CoreTests(unittest.TestCase):
    def test_workspace_bytes_and_normalization_no_private_inputs(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t); (root/'input.txt').write_bytes(b'hello\r\n'); docs,m=prepare_workspace(root,root)
            self.assertEqual(docs[0]['text'],'hello\n'); self.assertEqual(docs[0]['contentBase64'],'aGVsbG8NCg==')
            (root/'answer_key').mkdir(); (root/'answer_key/key.txt').write_text('secret')
            with self.assertRaises(ValueError):prepare_workspace(root,root)
    def test_symlink_escape_rejected(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t);(root/'escape').symlink_to('/etc/hosts')
            with self.assertRaises(ValueError):prepare_workspace(root,root)
    def test_chunks_are_size_bounded_and_preserve_order(self):
        docs=[{'text':'x'*400,'externalId':str(i)} for i in range(6)]
        batches=list(chunks(docs,1000)); self.assertEqual([d for b in batches for d in b],docs)
        self.assertTrue(all(len(json.dumps({'documents':b}).encode())<1000 for b in batches))
        with self.assertRaises(ValueError):list(chunks(docs,200))
    def test_live_mutations_fail_closed(self):
        for mode in ['live_model','mock_model',None]:
            with self.assertRaises(ValueError):require_free_runtime({'mode':mode},{'runtimeMode':mode})
    def test_seal_detects_changes(self):
        with tempfile.TemporaryDirectory() as t:
            p=Path(t); (p/'answer').write_text('original');seal(p);verify_seal(p);(p/'answer').write_text('changed')
            with self.assertRaises(ValueError):verify_seal(p)
    def test_export_does_not_fill_customers_or_recalculate_totals(self):
        with tempfile.TemporaryDirectory() as t:
            p=Path(t)/'out.csv';export_submission({'customerTotals':[{'customerId':'Z','legalName':'Zero','validInvoiceCount':0,'grossCents':0,'creditCents':0,'netCents':17}]},p)
            with p.open() as f: rows=list(csv.DictReader(f))
            self.assertEqual(len(rows),1);self.assertEqual(rows[0]['net_spend_usd'],'0.17')
    def test_strict_metrics_find_ignored_official_failures(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t); header='customer_id,valid_invoice_count,gross_invoice_spend_usd,credit_memo_total_usd,net_spend_usd\n'
            (root/'expected.csv').write_text(header+'X,1,100,0,100\n');(root/'actual.csv').write_text(header+'X,1,100,0,100\nX,2,101,1,100\nEXTRA,0,0,0,0\n')
            result=strict_customer_metrics(root/'actual.csv',root/'expected.csv');self.assertEqual(result['duplicateCustomerRows'],1);self.assertEqual(result['unexpectedCustomers'],['EXTRA']);self.assertEqual(result['allFourFieldsExactCents'],0);self.assertFalse(result['strictPass'])
    def test_missing_usage_is_not_zero(self):
        result=audit_state({'runtimeMode':'live_model','cases':[],'customerTotals':[]},[],[])
        self.assertIsNone(result['usage']['modelCalls']);self.assertIsNone(result['usage']['costUsd'])

class MockGatewayTests(unittest.TestCase):
    def setUp(self):
        self.seen=[]; seen=self.seen
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(self):
                self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Set-Cookie','session=synthetic; HttpOnly; SameSite=Strict; Path=/');self.end_headers()
                self.wfile.write(json.dumps({'runId':'mock','cases':[],'customerTotals':[],'runtimeMode':'deterministic','progress':{},'currency':'USD','batches':[]}).encode())
            def do_POST(self):
                seen.append({'cookie':self.headers.get('Cookie'),'session':self.headers.get('X-Invoice-MVP-Session'),'origin':self.headers.get('Origin'),'body':json.loads(self.rfile.read(int(self.headers['Content-Length'])))})
                self.send_response(409);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(b'{"error":{"code":"STALE_PROPOSAL","message":"private details"}}')
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler);self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
    def tearDown(self):self.server.shutdown();self.server.server_close();self.thread.join()
    def test_cookie_csrf_origin_and_structured_errors(self):
        client=AppClient(f'http://127.0.0.1:{self.server.server_port}');client.workspace()
        with self.assertRaises(ApiFailure) as caught:client.request('decisions',{'synthetic':True})
        self.assertEqual(caught.exception.code,'STALE_PROPOSAL');self.assertEqual(self.seen[0]['cookie'],'session=synthetic');self.assertEqual(self.seen[0]['session'],'1');self.assertEqual(self.seen[0]['origin'],'http://127.0.0.1:8790');self.assertNotIn('private details',str(caught.exception))
    def test_nonlocal_service_rejected(self):
        with self.assertRaises(ValueError):AppClient('https://example.com')

class OriginalScorerSemanticsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from core import digest, SCORER_SHA256
        upstream=os.environ.get('INVOICE_MVP_UPSTREAM')
        if not upstream: raise unittest.SkipTest('Set INVOICE_MVP_UPSTREAM to pinned evaluator-private clone')
        cls.original=(Path(upstream)/'scripts/score_submission.py').read_bytes()
        if digest(cls.original)!=SCORER_SHA256: raise ValueError('Modified original scorer')
    def invoke(self,expected,actual):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t);(root/'scripts').mkdir();(root/'answer_key').mkdir()
            (root/'scripts/score_submission.py').write_bytes(self.original)
            (root/'answer_key/customer_totals.csv').write_text('customer_id,net_spend_usd\n'+expected)
            (root/'submission.csv').write_text('customer_id,net_spend_usd\n'+actual)
            return subprocess.check_output([sys.executable,'-I',str(root/'scripts/score_submission.py'),str(root/'submission.csv')],text=True)
    def test_original_tolerance_inclusive_and_quantized(self):
        self.assertIn('customers_exact,1',self.invoke('SYNTH,10.00\n','SYNTH,10.014\n'))
        self.assertIn('customers_exact,0',self.invoke('SYNTH,10.00\n','SYNTH,10.02\n'))
    def test_original_duplicate_last_wins_and_extra_not_penalized(self):
        result=self.invoke('SYNTH,10.00\n','SYNTH,0\nSYNTH,10.00\nEXTRA,99.00\n')
        self.assertIn('customer_accuracy,1.0000',result);self.assertIn('unexpected_customers,1',result)
    def test_original_missing_negative_signed_error(self):
        result=self.invoke('SYNTH,-10.00\n','')
        self.assertIn('total_absolute_error_usd,-10.00',result);self.assertIn('missing_customers,1',result)

if __name__=='__main__':unittest.main()
