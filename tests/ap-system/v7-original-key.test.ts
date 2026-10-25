import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {expect,it} from 'vitest';
const repo=fileURLToPath(new URL('../..',import.meta.url));
const json=(file:string)=>JSON.parse(readFileSync(path.join(repo,file),'utf8'));
it('matches the held-out key to independently transcribed originals frozen before key access, preserving all104 facts',()=>{
 const original=json('docs/ap-orchestration/evidence/V7-original-derived.json'),key=json('fixtures/ap-system/heldout-suppliers-v1/evaluation/expected-outcomes.json');let facts=0;
 for(const invoice of original.logicalInvoices){const profile:any=Object.values(key.profiles).find((p:any)=>p.headers.invoiceNumber===invoice.invoiceNumber);expect(profile).toBeTruthy();
  for(const[field,value]of Object.entries(profile.headers))expect(invoice[field==='extractedSupplierName'?'supplier':field]).toEqual(value);
  expect(profile.lines).toEqual(invoice.lines);expect(profile.frame).toEqual({width:invoice.pageSizePoints[0],height:invoice.pageSizePoints[1],unit:'point',rotation:0});
  const n=Object.keys(profile.headers).length+profile.lines.reduce((sum:number,line:any)=>sum+Object.keys(line).length,0);expect(n).toBe(profile.fieldFactsPerDocument);facts+=n*invoice.files.length;
 }
 expect(facts).toBe(104);expect(key.scoring.contentFieldDenominator).toBe(104);expect(original.logicalInvoices.reduce((sum:number,i:any)=>sum+i.totalCents,0)).toBe(53650);
});
it('matches all four immutable PDF bytes to independent hashes and manifest, not filename equivalence',()=>{
 const original=json('docs/ap-orchestration/evidence/V7-original-derived.json'),manifest=json('fixtures/ap-system/heldout-suppliers-v1/manifest.json');expect(manifest.sources).toHaveLength(4);
 for(const source of manifest.sources){const file=readFileSync(path.join(repo,'fixtures/ap-system/heldout-suppliers-v1',source.path)),saved=original.files.find((f:any)=>f.filename===path.basename(source.path));expect(createHash('sha256').update(file).digest('hex')).toBe(saved.sha256);expect(source.sha256).toBe(saved.sha256);expect(file.length).toBe(saved.bytes);expect(source.byteLength).toBe(saved.bytes);}
 expect(new Set(original.files.map((f:any)=>f.sha256)).size).toBe(4);
});
