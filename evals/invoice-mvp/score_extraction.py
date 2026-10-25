#!/usr/bin/env python3
"""Supplemental persisted-proposal field metrics; never an accounting/official score."""
import argparse, csv
from decimal import Decimal
from pathlib import Path
from core import read_json, verify_seal, verify_upstream, write_json, seal, parse_money


def extraction_metrics(run, upstream):
    with (upstream / 'answer_key/invoices.csv').open(newline='', encoding='utf-8-sig') as f:
        key = {r['file_path']: r for r in csv.DictReader(f)}
    details = {d['case']['externalId']: d for d in read_json(run / 'details.json') if d['case']['status'] != 'superseded'}
    rows = []
    for path, expected in key.items():
        detail = details.get(path, {})
        proposal = detail.get('currentProposal') or {}
        c = proposal.get('conclusion', {})
        candidate = c.get('treatment') in ('include_invoice', 'include_credit')
        eligible = expected['policy'] in ('include', 'credit_memo')
        fields = {
            'customer': c.get('customerId') == expected['customer_id'],
            'number': c.get('documentNumber') == expected['document_id'],
            'amount': type(c.get('amountCents')) is int and Decimal(c['amountCents']) / 100 == abs(parse_money(expected['total_usd'])),
        }
        rows.append({'path': path, 'eligibleContribution': eligible, 'financialCandidate': candidate,
                     'fieldMatches': fields, 'allFieldsExact': candidate and all(fields.values()),
                     'kindMatchesEligible': eligible and c.get('treatment') == ('include_credit' if expected['policy'] == 'credit_memo' else 'include_invoice'),
                     'status': detail.get('case', {}).get('status'), 'hasReviewWarnings': bool(c.get('contradictions')),
                     'activeEffects': sum(bool(e['active']) for e in detail.get('contributions', []))})
    return {'metric': 'persisted_proposal_fields_not_acceptance_or_official_accuracy',
            'scoredDocuments': len(rows), 'eligibleDocuments': sum(r['eligibleContribution'] for r in rows),
            'financialCandidates': sum(r['financialCandidate'] for r in rows),
            'allCandidateFieldsExact': sum(r['allFieldsExact'] for r in rows),
            'eligibleDocumentsWithExactCandidate': sum(r['eligibleContribution'] and r['allFieldsExact'] and r['kindMatchesEligible'] for r in rows),
            'ineligibleDocumentsWithFinancialCandidate': sum(not r['eligibleContribution'] and r['financialCandidate'] for r in rows),
            'ineligibleCandidateActiveEffects': sum(r['activeEffects'] for r in rows if not r['eligibleContribution'] and r['financialCandidate']),
            'details': rows}


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--run', type=Path, required=True)
    p.add_argument('--upstream', type=Path, required=True)
    p.add_argument('--out', type=Path, required=True)
    args = p.parse_args()
    verify_seal(args.run)
    verify_upstream(args.upstream)
    args.out.mkdir(parents=True, exist_ok=False)
    result = extraction_metrics(args.run, args.upstream)
    write_json(args.out / 'extraction.json', result)
    seal(args.out)
    print({k: v for k, v in result.items() if k != 'details'})
