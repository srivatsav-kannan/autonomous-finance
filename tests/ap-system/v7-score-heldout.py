"""Independent offline scorer. Reads frozen V7 originals, never runtime answer key.
Usage: python3 SCRIPT REPO PRIVATE_RUN_DIR OUTPUT_JSON [intake-file] [runtime-SHA]
Provider presence is diagnostic, not candidate success. No network or writes to input.
"""
import sys,json,pathlib,hashlib,re,html
from html.parser import HTMLParser
from decimal import Decimal
from collections import Counter
repo,root,out=map(pathlib.Path,sys.argv[1:4]); intake_name=sys.argv[4] if len(sys.argv)>4 else 'initial.intake.private.json'
read=lambda p:json.loads(p.read_text())
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
original_path=repo/'docs/ap-orchestration/evidence/V7-original-derived.json';original=read(original_path)
def norm(s):return ' '.join(html.unescape(re.sub(r'<[^>]*>',' ',str(s))).split()).casefold()
def eq(a,b):
 if a is None:return False
 if isinstance(b,int):return isinstance(a,int) and not isinstance(a,bool) and a==b
 return norm(a)==norm(b)
HEADERS=['extractedSupplierName','invoiceNumber','invoiceDate','dueDate','terms','currency','subtotalCents','taxCents','freightCents','discountCents','totalCents']
class Tables(HTMLParser):
 def __init__(self):super().__init__();self.rows=[];self.row=None;self.cell=None
 def handle_starttag(self,t,a):
  if t=='tr':self.row=[]
  if t in ['td','th']:self.cell=''
  if t=='br' and self.cell is not None:self.cell+=' '
 def handle_data(self,d):
  if self.cell is not None:self.cell+=d
 def handle_endtag(self,t):
  if t in ['td','th'] and self.cell is not None:
   if self.row is not None:self.row.append(' '.join(self.cell.split()))
   self.cell=None
  if t=='tr' and self.row is not None:self.rows.append(self.row);self.row=None
labels={'extractedSupplierName':'Supplier','invoiceNumber':'Invoice Number','invoiceDate':'Invoice Date','dueDate':'Due Date','terms':'Terms','currency':'Currency'}
alllabels='|'.join(['Supplier','Invoice Number','Invoice Date','Due Date','Terms','Currency','Bill To','PO Reference','Work reference','Delivery Reference'])
def provider_fields(md):
 txt=re.sub(r'\*\*|__','',md);d={};quotes={}
 for key,label in labels.items():
  m=re.search(r'(?<!\w)'+label+r':\s*(.*?)(?=\s*(?:'+alllabels+r'):|\n|$)',txt,re.I)
  if m:d[key]=m.group(1).strip();quotes[key]=m.group(0).strip()
 p=Tables();p.feed(md)
 sums={'subtotal':'subtotalCents','tax':'taxCents','freight':'freightCents','discount':'discountCents','total':'totalCents','grand total':'totalCents'}
 columns=None
 for row in p.rows:
  if len(row)>=2 and norm(row[-2]) in sums:
   key=sums[norm(row[-2])];v=re.sub(r'[^0-9.\-]','',row[-1]);d[key]=int(Decimal(v)*100);quotes[key]=' | '.join(row[-2:])
  lower=[norm(c) for c in row]
  if 'sku' in lower and 'quantity' in lower and 'description' in lower:columns=lower;continue
  if columns and len(row)==len(columns) and re.fullmatch(r'[A-Z]+-[A-Z0-9]+',row[columns.index('sku')]):
   sku=row[columns.index('sku')]
   for col,v in zip(columns,row):
    key={'sku':'sku','description':'description','quantity':'quantity','uom':'unit','rate':'unitPriceCents','unit price':'unitPriceCents','line total':'amountCents','amount':'amountCents'}.get(col)
    if key:
     k=f'lines.{sku}.{key}';d[k]=int(Decimal(v)*100) if key.endswith('Cents') else v;quotes[k]=' | '.join(row)
 return d,quotes

def bbox(b):return {k:b.get(k,b.get({'width':'w','height':'h'}.get(k,k))) for k in ['x','y','width','height']}
def samebox(a,b):return all(abs(a[k]-b[k])<0.021 for k in a)
def span(s,a):return s.encode()[a[0]:a[1]].decode()
def audit_geometry(e,expected_source,frame,d):
 g=e['grounding'];errors=[];rawmatches=[]
 if g['status']=='unresolved':return ['unresolved:'+str(g['failureReason'])]
 if e['source']!=expected_source:errors.append('source_triple')
 if g['page']!=1:errors.append('wrong_page')
 if g['frame']!={'width':frame[0],'height':frame[1],'units':'point','origin':'top_left','rotation':0,'transform':[1,0,0,1,0,0]}:errors.append('frame')
 proc=g['processor'];art={}
 for k in ['configArtifact','rawArtifact','tokenArtifact','rasterArtifact']:
  v=proc.get(k)
  if v:
   p=d/v['ref'];assert sha(p)==v['sha256'],str(p);art[k]=[json.loads(line) for line in p.read_text().splitlines()] if p.suffix=='.jsonl' else read(p)
 regs=g['regions'];quote=norm(e['quote'])
 for r in regs:
  if r['granularity'] not in ['word','line','cell'] or r['width']<=0 or r['height']<=0 or r['x']<0 or r['y']<0 or r['x']+r['width']>frame[0]+.01 or r['y']+r['height']>frame[1]+.01:errors.append('invalid_box')
 if not regs:errors.append('missing_regions')
 if g['method']=='native':
  pages=art['rawArtifact'];page=next(p for p in pages if p['page_number']==1);assert page['success'] and (page['page_width'],page['page_height'])==tuple(frame)
  tokens={};options=[]
  for ii,item in enumerate(page['items']):
   md=item.get('md',item.get('value',''))
   for li,line in enumerate(item.get('grounding',{}).get('lines',[])):
    if line.get('bbox'):options.append((norm(span(md,line['span'])),[bbox(line['bbox'])],1))
    for wi,w in enumerate(line.get('words',[])):
     tokens[f'native:1:{ii}:{li}:{wi}']=(norm(span(md,w['span'])),bbox(w['bbox']))
   for ri,row in enumerate(item.get('rows',[])):
    for ci,txt in enumerate(row):
     cells=item.get('grounding',{}).get('rows',[])
     if ri>=len(cells) or ci>=len(cells[ri]) or not cells[ri][ci]:continue
     cell=cells[ri][ci];bs=cell.get('bbox',[]);bs=bs if isinstance(bs,list) else [bs]
     if bs:options.append((norm(txt),[bbox(b) for b in bs],len(cell.get('lines',[]))))
     if cell.get('lines'):options.append((norm(txt),[bbox(l['bbox']) for l in cell['lines']],len(cell['lines'])))
  refs=[ref for r in regs for ref in r['tokenRefs']]
  if refs:
   try:
    if norm(' '.join(tokens[r][0] for r in refs))!=quote:errors.append('native_token_text')
    for r in regs:
     if len(r['tokenRefs'])!=1 or not samebox(bbox(r),tokens[r['tokenRefs'][0]][1]):errors.append('native_token_box')
   except KeyError:errors.append('native_token_missing')
  else:
   rawmatches=[o for o in options if o[0]==quote and len(o[1])==len(regs) and all(samebox(bbox(r),b) for r,b in zip(regs,o[1]))]
   if not rawmatches:errors.append('native_no_exact_raw_region')
   elif min(o[2] for o in rawmatches)>1 and len(regs)<min(o[2] for o in rawmatches):errors.append('multiline_collapsed')
 elif g['method'] in ['raw_word_exact','local_ocr_exact']:
  token=art['tokenArtifact']
  if g['method']=='raw_word_exact':
   page=next(p for p in token if p['page_number']==1);tokens={f'raw:1:{i}':{'text':w.get('str',w.get('text','')),'box':bbox(w),'page':1} for i,w in enumerate(page['raw_words'])}
  else:
   assert token['source']==expected_source;tokens={w['id']:w for w in token['words']}
   cfg=art['configArtifact'];assert cfg['source']==expected_source
  words=[]
  for r in regs:
   selected=[tokens[t] for t in r['tokenRefs']];words+=selected
   if not selected or any(w['page']!=1 for w in selected):errors.append('derived_token_page')
   if selected:
    bs=[w['box'] for w in selected];x=min(b['x'] for b in bs);y=min(b['y'] for b in bs);b={'x':x,'y':y,'width':max(z['x']+z['width'] for z in bs)-x,'height':max(z['y']+z['height'] for z in bs)-y}
    if not samebox(bbox(r),b):errors.append('derived_token_box')
  if norm(' '.join(w['text'] for w in words))!=quote:errors.append('derived_token_text')
 else:errors.append('unhandled_method')
 return sorted(set(errors))

reports=[]
for f in original['files']:
 name=f['filename'][:-4];d=root/name;j=read(d/intake_name);doc=j['documents'][0];inv=next(i for i in original['logicalInvoices'] if f['filename'] in i['files'])
 assert doc['sha256']==f['sha256'] and doc['revision']==1 and sha(d/doc['originalRef'])==f['sha256']
 expected={k:inv['supplier' if k=='extractedSupplierName' else k] for k in HEADERS}
 for line in inv['lines']:
  for k,v in line.items():expected[f"lines.{line['sku']}.{k}"]=v
 evidence=j['candidate']['evidence'] if j['candidate'] is not None else j['extraction']['evidence'];skus={e['fieldPath'].rsplit('.',1)[0]:e['normalizedValue'] for e in evidence if e['fieldPath'].endswith('.sku')}
 found={}
 for e in evidence:
  key=e['fieldPath']
  if key.startswith('lines.'):
   group,field=key.rsplit('.',1);key=f'lines.{skus.get(group,"UNKNOWN")}.{field}'
  assert key not in found;found[key]=e
 providers=[]
 for p in (d/'artifacts').glob('*.json'):
  o=read(p)
  if isinstance(o,dict) and isinstance(o.get('markdown'),dict):providers.append((p,o))
 assert len(providers)==1
 pp,provider=providers[0];md='\n'.join(p['markdown'] for p in provider['markdown']['pages']);values,quotes=provider_fields(md)
 candidate_values={}
 if j['candidate'] is not None:
  c=j['candidate'];candidate_values={k:c.get(k) for k in HEADERS}
  for line in c['lines']:
   for k in ['sku','description','quantity','unit','unitPriceCents','amountCents']:
    v=line['quantity']['decimal' if k=='quantity' else 'unit'] if k in ['quantity','unit'] else line[k]
    candidate_values[f"lines.{line['sku']}.{k}"]=v
 rows=[]
 for key,value in expected.items():
  e=found.get(key);state='missing' if e is None else 'correct' if eq(e['normalizedValue'],value) else 'wrong'
  errors=['missing_evidence'] if e is None else audit_geometry(e,{'sourceId':doc['sourceId'],'revision':1,'sha256':f['sha256']},inv['pageSizePoints'],d)
  if e is not None and state!='correct':errors.append('wrong_field_content')
  rows.append({'field':key,'expected':value,'provider':{'value':values.get(key),'correct':eq(values.get(key),value),'quote':quotes.get(key)},'candidate':{'value':candidate_values.get(key),'correct':eq(candidate_values.get(key),value)},'adapter':{'value':e['normalizedValue'] if e else None,'content':state,'evidenceId':e['evidenceId'] if e else None,'geometry': 'verified' if not errors else 'not_accepted','geometryReasons':errors,'method':e['grounding']['method'] if e else None}})
 reports.append({'document':name,'originalSha256':f['sha256'],'intakeSha256':sha(d/intake_name),'providerResultSha256':sha(pp),'providerJob':doc['parser']['jobId'],'candidatePresent':j['candidate'] is not None,'extractionStatus':j['extraction']['status'],'reasons':j['extraction']['reasons'],'denominator':len(rows),'candidateCorrect':sum(r['candidate']['correct'] for r in rows),'providerCorrect':sum(r['provider']['correct'] for r in rows),'adapterContent':dict(Counter(r['adapter']['content'] for r in rows)),'adapterGeometryVerified':sum(r['adapter']['geometry']=='verified' for r in rows),'fields':rows})
summary={'denominator':sum(r['denominator'] for r in reports),'providerCorrect':sum(r['providerCorrect'] for r in reports),'candidateCorrect':sum(r['candidateCorrect'] for r in reports),'completeCandidates':sum(r['candidatePresent'] for r in reports),'adapterContent':dict(sum((Counter(r['adapterContent']) for r in reports),Counter())),'adapterGeometryVerified':sum(r['adapterGeometryVerified'] for r in reports)}
result={'reviewKind':'independent agent engineering review; no practitioner sign-off','originalDerivationSha256':sha(original_path),'scorerSha256':sha(pathlib.Path(__file__)),'runtimeBaseline':sys.argv[5] if len(sys.argv)>5 else '6a0294197208fc891e715ea556d1a9b5e9f40aab','intakeFilename':intake_name,'method':'Frozen original-derived fields; independently read provider labeled text and HTML tables, adapter normalized evidence, source/frame/hashed raw native regions and derived token rectangles. Provider correctness is semantic content presence, not candidate or end-to-end success. Candidate:null is a complete-document failure.','summary':summary,'documents':reports}
out.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(summary));print(json.dumps([{k:v for k,v in r.items() if k!='fields'} for r in reports],indent=2))
