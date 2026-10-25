import {tmpdir} from 'node:os';
/** Independent network-forbidden cached replay; reads original inputs and trusted context only. */
import {readFile,writeFile,mkdir,cp,mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {combineUploads} from '../../src/ap-system/ingestion/index';
async function main(){
 const repo=fileURLToPath(new URL('../..',import.meta.url)),root=await mkdtemp(`${tmpdir()}/ap97-v7-cached-`),old=process.argv[2],expected=process.argv[3];
 if(!old||!expected)throw Error('usage: v7-cached-parser-replay.ts baseline-private-root repair-private-root');
 const fixture=path.join(repo,'fixtures/ap-system/heldout-suppliers-v1');
 const manifest=JSON.parse(await readFile(path.join(fixture,'manifest.json'),'utf8')),contexts=JSON.parse(await readFile(path.join(fixture,'runtime-contexts.json'),'utf8'));
 const result:any[]=[];let networkCalls=0;
 for(const s of manifest.sources){
  const dir=path.join(root,s.id);await mkdir(dir,{recursive:true});
  for(const kind of ['artifacts','jobs'])await cp(path.join(old,s.id,kind),path.join(dir,kind),{recursive:true});
  const bytes=await readFile(path.join(fixture,s.path));if(createHash('sha256').update(bytes).digest('hex')!==s.sha256)throw Error('source_hash');
  const intake=await combineUploads({uploads:[{bytes,name:path.basename(s.path),mimeType:s.mimeType,sourceId:'heldout-v1-'+s.id,revision:1,deliveryId:'heldout-v1-'+s.id+'-delivery-1',kind:'invoice',provenance:s.provenance}],storageRoot:dir,idempotencyKey:'heldout-v1-'+s.id+'-intake-1',context:contexts[s.supplierId],options:{fetcher:async()=>{networkCalls++;throw Error('network_forbidden');},parserVersion:'2026-09-28',ocr:{traineddataPath:'/opt/homebrew/share/tessdata/eng.traineddata',tesseractPath:'/opt/homebrew/bin/tesseract',pdfinfoPath:'/opt/homebrew/bin/pdfinfo',pdftoppmPath:'/opt/homebrew/bin/pdftoppm',timeoutMs:20000,maxPages:8}}});
  const serial=JSON.stringify(intake,null,2)+'\n';await writeFile(path.join(dir,'independent.intake.private.json'),serial,{mode:0o600});
  const prior=await readFile(path.join(expected,s.id,'replay.intake.private.json'),'utf8');
  result.push({source:s.id,hash:createHash('sha256').update(serial).digest('hex'),ownerReplayByteIdentical:serial===prior,candidate:Boolean(intake.candidate)});
 }
 if(networkCalls)throw Error('attempted_network');
 const report={root,networkCalls,result};await writeFile(`${tmpdir()}/ap97-v7-independent-replay.json`,JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
