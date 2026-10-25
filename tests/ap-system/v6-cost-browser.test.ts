import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {expect,it} from 'vitest';
import {createServer} from 'vite';
import {chromium} from '@playwright/test';
import {mkdtemp,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import type {CostState} from '../../src/ap-system/cost-contracts';
const state=(id:string,corrected=true):CostState=>({originalEntryId:id,billId:'bill',accrualId:null,supplierId:'supplier',snapshotHash:'a'.repeat(64),latestDate:'2026-10-31',originalShares:[{originalLineId:'line-1',allocationIndex:0,account:'5000',store:'store',treatment:'expense',period:'2026-10',side:'credit',amountCents:7700,remainingCents:7700}],positions:[{account:'5000',store:'store',balanceCents:3700},{account:'1200',store:'store',balanceCents:4000}],corrections:corrected?[{actionId:'action',entryId:'adjustment',date:'2026-10-31',fromAccount:'5000',toAccount:'1200',store:'store',amountCents:4000}]:[]});
it('invalidates mounted UI review after editing and parent context changes, ignores late responses and rejects wrong journal IDs',async()=>{
 const cache=await mkdtemp(`${tmpdir()}/ap97-v6-browser-`);const root=fileURLToPath(new URL('../..',import.meta.url));
 const server=await createServer({configFile:false,envFile:false,root,cacheDir:cache,logLevel:'error',server:{host:'127.0.0.1',port:0},plugins:[{name:'independent-v6-page',configureServer(s){s.middlewares.use('/v6-fixture',(_q,r)=>{r.setHeader('Content-Type','text/html');r.end('<div id="root"></div><script type="module" src="/tests/ap-system/v6-cost-browser.fixture.tsx"></script>');});}}]});
 let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
 try{await server.listen();const url=server.resolvedUrls!.local[0]!;browser=await chromium.launch({executablePath:process.env.CHROME_PATH??(existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined),headless:true});const page=await browser.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url+'v6-fixture');await page.waitForFunction(()=>((window as any).v6Deferred?.length??0)===1);
  await page.getByRole('button',{name:'Switch original'}).click();await page.waitForFunction(()=>((window as any).v6Deferred?.length??0)===2);
  await page.evaluate(value=>(window as any).v6Deferred[1].resolve(value),state('B'));await page.getByRole('button',{name:'Add exact reversal share'}).waitFor();
  await page.evaluate(value=>(window as any).v6Deferred[0].resolve(value),state('A',false));await page.evaluate(()=>new Promise(requestAnimationFrame));expect(await page.getByTestId('ready').textContent()).toBe('false');expect(await page.evaluate(()=>(window as any).v6Deferred[0].signal.aborted)).toBe(true);
  await page.getByRole('button',{name:'Add exact reversal share'}).click();await page.getByLabel('Current reachable cost account').selectOption('1200');await page.getByLabel('Exact reversal amount (USD)').fill('38.50');await page.getByLabel('Independent source / Revision 1').check();await page.getByLabel('Reason for these corrected shares').fill('Independent mounted review');await page.getByLabel('I reviewed the exact original shares, current accounts, signed amounts and evidence.').check();await page.getByRole('button',{name:'Use reviewed cost allocation plan'}).click();expect(await page.getByTestId('ready').textContent()).toBe('true');
  await page.getByLabel('Exact reversal amount (USD)').fill('38.49');expect(await page.getByTestId('ready').textContent()).toBe('false');expect(await page.getByLabel('I reviewed the exact original shares, current accounts, signed amounts and evidence.').isChecked()).toBe(false);
  await page.getByLabel('I reviewed the exact original shares, current accounts, signed amounts and evidence.').check();await page.getByRole('button',{name:'Use reviewed cost allocation plan'}).click();expect(await page.getByTestId('ready').textContent()).toBe('true');
  await page.getByRole('button',{name:'Revise parent context'}).click();await page.waitForFunction(()=>((window as any).v6Deferred?.length??0)===3);expect(await page.getByTestId('ready').textContent()).toBe('false');await page.getByRole('status').filter({hasText:'Loading exact original shares'}).waitFor();expect(await page.getByRole('button',{name:'Use reviewed cost allocation plan'}).count()).toBe(0);
  await page.evaluate(value=>(window as any).v6Deferred[2].resolve(value),state('wrong-journal',false));await page.getByRole('alert').waitFor();expect(await page.getByRole('alert').textContent()).toContain('does not match');expect(await page.getByTestId('ready').textContent()).toBe('false');expect(errors).toEqual([]);
 }finally{await browser?.close();await server.close();await rm(cache,{recursive:true,force:true});}
},60000);
