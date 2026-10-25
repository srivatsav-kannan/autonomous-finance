import csv, json, tempfile, unittest
from pathlib import Path
from score_extraction import extraction_metrics


class ExtractionScoreTests(unittest.TestCase):
    def test_proposals_are_not_effects_and_credit_sign_is_normalized(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'answer_key').mkdir()
            with (root / 'answer_key/invoices.csv').open('w', newline='') as f:
                w = csv.DictWriter(f, fieldnames=['file_path', 'document_id', 'customer_id', 'policy', 'total_usd'])
                w.writeheader()
                w.writerows([
                    dict(file_path='credit', document_id='CM-1', customer_id='A', policy='credit_memo', total_usd='-25.00'),
                    dict(file_path='copy', document_id='I-1', customer_id='A', policy='duplicate', total_usd='100.00'),
                    dict(file_path='missing', document_id='I-2', customer_id='A', policy='include', total_usd='50.00'),
                ])
            def detail(path, number, amount, treatment):
                return {'case': {'externalId': path, 'status': 'needs_review'}, 'contributions': [],
                        'currentProposal': {'conclusion': {'customerId': 'A', 'documentNumber': number, 'amountCents': amount, 'treatment': treatment, 'contradictions': ['Review required']}}}
            (root / 'details.json').write_text(json.dumps([detail('credit', 'CM-1', 2500, 'include_credit'), detail('copy', 'I-1', 10000, 'include_invoice')]))
            result = extraction_metrics(root, root)
            self.assertEqual(result['eligibleDocuments'], 2)
            self.assertEqual(result['allCandidateFieldsExact'], 2)
            self.assertEqual(result['eligibleDocumentsWithExactCandidate'], 1)
            self.assertEqual(result['ineligibleDocumentsWithFinancialCandidate'], 1)
            self.assertEqual(result['ineligibleCandidateActiveEffects'], 0)


if __name__ == '__main__':
    unittest.main()
