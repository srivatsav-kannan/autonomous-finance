import { chromium } from '@playwright/test';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const dir=path.resolve('docs/ap-orchestration/evidence/guidance-upload-20261025');await mkdir(dir,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
process.on('uncaughtException',async e=>{console.error(e);console.error((await page.locator('body').innerText()).slice(-9000));await page.screenshot({path:'/tmp/guidance-failure.png',fullPage:true});await browser.close();process.exit(1);});
const base='http://127.0.0.1:5198';
await page.goto(base+'/ap-system');
await page.locator('.ap-local-simulation select').selectOption('field-reviewer');
await page.getByRole('button',{name:'Upload documents',exact:true}).waitFor();
const results=[];
for(const [key,file,expected] of [['B','cleaning-b.pdf','Why A applies'],['C','renovation-c.pdf','Why A was not used: pending review']]){
 await page.getByRole('button',{name:'Upload documents',exact:true}).click();
 await page.getByLabel('Original documents',{exact:true}).setInputFiles('fixtures/ap-system/guidance-pdfs/'+file);
 await page.getByRole('button',{name:'Create AP case',exact:true}).click();
 await page.getByRole('heading',{name:expected,exact:true}).waitFor({timeout:30000});
 const caseId=new URL(page.url()).searchParams.get('case');
 const data=await page.evaluate(async(id)=>{const h={Authorization:'Bearer local:field-reviewer'};const detail=await fetch('/api/ap-system/cases/'+id,{headers:h}).then(r=>r.json());const guidance=await fetch('/api/ap-system/cases/'+id+'/guidance',{headers:h}).then(r=>r.json()).then(v=>v.guidance);return {detail,guidance};},caseId);
 if(!data.guidance?.id)throw Error('Missing persisted guidance');
 await page.getByRole('button',{name:'View current original PDF',exact:true}).click();
 await page.getByRole('img',{name:'Current original PDF, page 1'}).waitFor();
 await page.getByRole('img',{name:'Current original PDF, page 1'}).screenshot({path:dir+'/'+key+'-original.png'});
 await page.getByRole('button',{name:'Close original',exact:true}).click();
 const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'Download current original: '+file,exact:true}).click();const download=await downloadPromise;const dlpath=await download.path();const bytes=await readFile(dlpath);const hash=createHash('sha256').update(bytes).digest('hex');if(hash!==data.detail.sources[0].sha256)throw Error('Download hash mismatch');
 await page.getByRole('region',{name:'Case coding guidance'}).screenshot({path:dir+'/'+key+'-guidance.png'});
 await page.reload();await page.locator('.ap-local-simulation select').selectOption('field-reviewer');await page.getByRole('heading',{name:expected,exact:true}).waitFor();
 const after=await page.evaluate(async(id)=>fetch('/api/ap-system/cases/'+id+'/guidance',{headers:{Authorization:'Bearer local:field-reviewer'}}).then(r=>r.json()).then(v=>v.guidance),caseId);
 if(JSON.stringify(after)!==JSON.stringify(data.guidance))throw Error('Refresh changed saved recommendation');
 results.push({key,caseId,hash,sourceBindings:data.detail.currentSourceBindings,revision:data.detail.revision,snapshotHash:data.detail.snapshotHash,guidance:data.guidance,states:data.detail.states,links:data.detail.links,journals:data.detail.journals,payments:data.detail.payments,refreshExact:true});
}
for(const colorScheme of ['light','dark'])for(const width of [1440,390]){await page.emulateMedia({colorScheme});await page.setViewportSize({width,height:1000});await page.screenshot({path:`${dir}/C-${colorScheme}-${width}.png`,fullPage:true});}
await writeFile(dir+'/browser-results.json',JSON.stringify({results,errors},null,2));await browser.close();if(errors.length)throw Error(errors.join('\n'));console.log('B/C upload, saved advice, original view/download and refresh verified');
