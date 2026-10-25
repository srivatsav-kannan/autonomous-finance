import datetime, json, pathlib, subprocess, sys, time
base=pathlib.Path(__file__).resolve().parent
name=sys.argv[1]; limit=int(sys.argv[2]); argv=sys.argv[3:]
started=datetime.datetime.now(datetime.timezone.utc).isoformat(); t=time.monotonic()
outfile=base/'logs'/f'{name}.stdout'; errfile=base/'logs'/f'{name}.stderr'
with outfile.open('wb') as out, errfile.open('wb') as err:
 p=subprocess.Popen(argv,stdout=out,stderr=err)
 try:
  code=p.wait(timeout=limit);timed=False
 except subprocess.TimeoutExpired:
  p.kill();p.wait();code=124;timed=True
record={'argv':argv,'startedUtc':started,'durationSeconds':round(time.monotonic()-t,3),'exitCode':code,'timedOut':timed,'stdout':f'logs/{name}.stdout','stderr':f'logs/{name}.stderr'}
(base/'logs'/f'{name}.json').write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps(record))
for f in [outfile,errfile]:
 lines=f.read_text(errors='replace').splitlines();print('\n'.join(lines[-120:]))
sys.exit(code)
