#!/usr/bin/env python3
"""Grade a sealed capped-baseline run; never calls a model."""
import argparse,subprocess,sys
from pathlib import Path
from core import *

def main(args):
    verify_seal(args.run);verified=verify_upstream(args.upstream)
    if args.out.resolve().is_relative_to(ROOT.resolve()):raise ValueError('Grading output must be evaluator-private')
    submission=args.run/'live-output/submission.csv'
    if not submission.exists():raise ValueError('Baseline did not submit; retain partial/budget outcome, no fabricated score')
    args.out.mkdir(parents=True,exist_ok=False)
    completed=subprocess.run([sys.executable,'-I',str(args.upstream/'scripts/score_submission.py'),str(submission.resolve())],capture_output=True,text=True,check=True)
    (args.out/'official_score.txt').write_text(completed.stdout)
    official={}
    for line in completed.stdout.splitlines():
        if not line:break
        key,value=line.split(',',1);official[key]=value
    result={'system':'A-capped','official':official,'strictCustomerMetrics':strict_customer_metrics(submission,args.upstream/'answer_key/customer_totals.csv'),'runSealSha256':digest((args.run/'artifact-manifest.json').read_bytes()),'upstream':verified,'source':source_identity(),'configuration':read_json(args.run/'live-output/configuration.json'),'status':read_json(args.run/'live-output/final-status.json')}
    write_json(args.out/'score.json',result);seal(args.out);print(json.dumps({'official':official,'strict':result['strictCustomerMetrics']},indent=2))
if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--run',type=Path,required=True);p.add_argument('--upstream',type=Path,required=True);p.add_argument('--out',type=Path,required=True)
    try:main(p.parse_args())
    except Exception as exc:print(f'{type(exc).__name__}: {exc}',file=sys.stderr);sys.exit(1)
