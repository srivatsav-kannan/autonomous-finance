// Explicitly isolated UI fixture test. This does not run the AP backend or a bank workflow.
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { strict as assert } from 'node:assert';
import { apUIFixture, uiSourceHash, uiSourceText } from './ap-system-ui.fixture.ts';
const out = new URL('../var/ap97-d1-browser/',import.meta.url);
await mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const report={scope:'UI component fixture only; no backend/provider/accounting verification',screenshots:[],checks:[],errors:[]};
try {
  const sourcePage=await browser.newPage({viewport:{width:600,height:800}});
  await sourcePage.setContent(`<html><body style="margin:0;background:#fff;color:#202520;font:18px Arial"><div style="position:absolute;left:55px;top:40px;color:#686f68">Synthetic UI component fixture only</div><h1 style="position:absolute;left:55px;top:125px;font-size:24px;margin:0">Golden State Produce Co.</h1><div style="position:absolute;left:55px;top:180px">Invoice UI-1042</div><div style="position:absolute;left:55px;top:270px">Kale cases 2 × $38.50 = $77.00</div><div style="position:absolute;left:55px;top:305px">Tomatoes $28.50</div><div style="position:absolute;left:55px;top:390px">Total $105.50</div><div style="position:absolute;left:55px;top:730px;font-size:14px">Not integrated AP or provider verification</div></body></html>`);
  const raster=await sourcePage.screenshot();await sourcePage.close();
  const context=await browser.newContext({viewport:{width:1440,height:1050},colorScheme:'light'});
  const page=await context.newPage();let data=apUIFixture();let wrongRaster=false;const calls=[];
  page.on('pageerror',e=>report.errors.push(e.message));
  await page.route('**/api/ap-system/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();
    calls.push({method,path});
    const json=body=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
    if(path.endsWith('/pages/1'))return route.fulfill({status:200,contentType:'image/png',headers:{'X-AP-Source-SHA256':wrongRaster ? 'wrong' : uiSourceHash,'X-AP-Source-Revision':'1','X-AP-Page':'1'},body:raster});
    if(path.startsWith('/api/ap-system/sources/'))return route.fulfill({status:200,contentType:'text/plain',body:uiSourceText});
    if(path==='/api/ap-system/cases')return json([data]);
    if(method==='POST' && path.endsWith('/review')){const body=request.postDataJSON();assert.equal(body.snapshotHash,data.snapshotHash);assert.equal(body.sourceBindings[0].sha256,uiSourceHash);data.states.document='reviewed';return json({decisionId:'fixture-field-review'});}
    if(method==='POST' && path.endsWith('/approve')){assert.equal(request.postDataJSON().acceptedCents,10550);data.states.business='approved';data.states.accounting='recognized';data.amounts.acceptedCents=10550;data.amounts.outstandingCents=10550;data.links.billId='fixture-bill';return json({billId:'fixture-bill'});}
    if(method==='POST' && path.endsWith('/payments')){data.states.authorization='awaiting_approval';data.payments=[{versionId:'fixture-payment',commandId:null,amountCents:10550,status:'awaiting_approval',beneficiaryVersion:'v1',providerTransferId:null,authorizedBy:[]}];return json({versionId:'fixture-payment',snapshotHash:'payment-snapshot'});}
    if(method==='POST' && path.endsWith('/authorize')){const body=request.postDataJSON();assert.equal(body.paymentSnapshotHash,'payment-snapshot');assert.equal(body.snapshotHash,data.snapshotHash);data.states.authorization='authorized';data.states.execution='queued';data.payments[0].status='queued';return json({commandId:'fixture-command'});}
    if(path==='/api/ap-system/payments/fixture-payment')return json({snapshot:{scope:data.scope,bills:[{billId:'fixture-bill',version:1,amountCents:10550}],credits:[],amountCents:10550,currency:'USD',destination:{externalAccountId:'fake-ui-beneficiary',version:'v1'},policyVersion:'golden-state-ap-v1'},snapshotHash:'payment-snapshot',approvals:[],observations:[],transactions:[]});
    if(path==='/api/ap-system/cases/component-fixture-1042')return json(data);
    return route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({error:{code:'not_found',reason:'UI fixture route not implemented'}})});
  });
  await page.goto('http://127.0.0.1:5191/ap-system?case=component-fixture-1042');
  await page.getByRole('heading',{name:'UI-1042',exact:true}).waitFor();
  await page.locator('svg.aps-page').waitFor();
  assert.equal(await page.locator('polygon.aps-region.native').count(),1);report.checks.push('Native region renders against exact source headers');
  await page.getByRole('button',{name:/Line_description|Line description/}).click();
  await page.locator('polygon.aps-region.derived').first().waitFor();assert.equal(await page.locator('polygon.aps-region.derived').count(),2);report.checks.push('Derived multiline evidence stays as two regions');
  for(const scheme of ['light','dark'])for(const width of [1440,390]){
    await page.emulateMedia({colorScheme:scheme});await page.setViewportSize({width,height:1050});
    await page.evaluate(()=>new Promise(requestAnimationFrame));
    const overflow=await page.evaluate(()=>({root:document.documentElement.scrollWidth,body:document.body.scrollWidth,viewport:innerWidth}));assert.equal(overflow.root<=overflow.viewport && overflow.body<=overflow.viewport,true,`${scheme} ${width} overflow: ${JSON.stringify(overflow)}`);
    const name=`derived-${scheme}-${width}.png`;await page.screenshot({path:new URL(name,out).pathname,fullPage:true});report.screenshots.push(name);
  }
  report.checks.push('Desktop and phone in light/dark have no horizontal overflow');
  await page.setViewportSize({width:1440,height:1050});await page.emulateMedia({colorScheme:'light'});
  await page.getByRole('button',{name:/^Total/}).click();await page.getByText('Only coarse context is shown.',{exact:false}).waitFor();assert.equal(await page.locator('polygon.aps-region.derived').count(),0);await page.locator('polygon.context').waitFor();
  await page.screenshot({path:new URL('unresolved-light-1440.png',out).pathname,fullPage:true});report.screenshots.push('unresolved-light-1440.png');report.checks.push('Unresolved evidence displays only labeled coarse context');
  wrongRaster=true;await page.getByRole('button',{name:/^Supplier/}).click();await page.getByText(/page preview does not match this source version/).waitFor();assert.equal(await page.locator('svg.aps-page').count(),0);report.checks.push('Mismatched preview hash hides every highlight');wrongRaster=false;
  await page.getByLabel('Decision reason').fill('UI component test: checked the synthetic source');
  await page.getByLabel('I inspected the correct original source revision and supporting evidence.').check();
  assert.equal(await page.getByRole('button',{name:'Approve bill $105.50'}).isDisabled(),true);
  await page.getByRole('button',{name:'Record field review'}).click();await page.getByText('Reviewed',{exact:true}).waitFor();
  await page.getByLabel('Decision reason').fill('UI component test: bill reviewed independently');await page.getByLabel('I inspected the correct original source revision and supporting evidence.').check();
  await page.getByRole('button',{name:'Approve bill $105.50'}).click();await page.getByText('Bill approved. Payment has not been requested.').waitFor();
  assert.equal(calls.filter(c=>c.path.endsWith('/payments')&&c.method==='POST').length,0);report.checks.push('Field review then bill approval never auto-prepares or authorizes payment');
  await page.getByRole('button',{name:'Accounting',exact:true}).click();await page.getByRole('button',{name:'Prepare payment proposal'}).click();await page.getByRole('button',{name:'Inspect payment'}).click();
  await page.getByRole('heading',{name:'Authorized scope'}).waitFor();assert.equal(await page.getByRole('button',{name:'Authorize this payment'}).isDisabled(),true);
  await page.getByLabel('I authorize $105.50 from this funding account to this verified beneficiary version.').check();await page.getByRole('button',{name:'Authorize this payment'}).click();await page.getByText('Bill approved. Payment authorization: Authorized.').waitFor();
  report.checks.push('Independent payment confirmation sends AP and payment snapshot hashes');
  assert.deepEqual(report.errors,[]);report.checks.push('No uncaught browser exceptions');
  report.requests=calls;report.status='passed';await context.close();
} catch(error) { report.status='failed';report.failure=String(error);throw error; }
finally { await writeFile(new URL('report.json',out),JSON.stringify(report,null,2));await browser.close(); }
