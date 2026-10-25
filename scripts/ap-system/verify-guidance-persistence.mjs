import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const path='docs/ap-orchestration/evidence/guidance-upload-20261025/';
const saved=JSON.parse(await readFile(path+'browser-results.json','utf8'));
const base='http://127.0.0.1:8830/api/ap-system';
const r=await fetch(base+'/cases',{headers:{Authorization:'Bearer local:field-reviewer'}});assert.equal(r.status,200);
const cases=await r.json();const cookie=r.headers.get('set-cookie').split(';')[0];
const headers={Authorization:'Bearer local:field-reviewer',cookie,origin:'http://127.0.0.1:5198','X-AP-System-Session':'1','Content-Type':'application/json'};
const results=[];
assert.equal(cases.length,2);
for(const item of saved.results){
 const c=cases.find(c=>c.caseId===item.caseId);assert.ok(c);
 const current=await fetch(base+'/cases/'+item.caseId+'/guidance',{headers}).then(r=>r.json());assert.deepEqual(current.guidance,item.guidance);
 const rerun=await fetch(base+'/cases/'+item.caseId+'/guidance',{method:'POST',headers,body:JSON.stringify({expectedRevision:c.revision,snapshotHash:c.snapshotHash})}).then(r=>r.json());assert.deepEqual(rerun,item.guidance);
 assert.equal(c.links.billId,null);assert.equal(c.journals.length,0);assert.equal(c.payments.length,0);assert.equal(c.links.commandIds.length,0);
 results.push({key:item.key,caseId:c.caseId,guidanceId:rerun.id,restartExact:true,recheckExact:true,bills:0,journals:0,payments:0,commands:0});
}
await writeFile(path+'restart-results.json',JSON.stringify({results,totalCases:cases.length},null,2));console.log('Exact advice survived process restart; reruns stable; 2 cases; zero case financial effects.');
