# V-C1 — independent payment/source component verification

Verdict: **PASS for the scoped C1 component at the code SHA below.** No blocking defect was reproduced in this scope. This is an independent engineering review; it is **not I1, V1, V2, live Increase verification, or AP practitioner sign-off**.

## Identity and scope

- Task: C1 independent verification, assigned directly by Master to `/root/verifier` (not an A/B/C/D implementation owner).
- Code SHA: `91198cfae532f75e443bcd39407bb9a76160f1e0`.
- Adopted specification SHA256: `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`.
- Contract: `ap-evidence-v1`; policy expectations taken from `MASTER.md` and `CONTRACTS.md` in this snapshot.
- Worktree: `/Users/junjiexiong/.codex/worktrees/ap-system-verification/calhacks`.
- Report branch: `codex/ap-system-verification`; the branch adds only this report, without implementation changes.
- Run ID used by the independent harness: `ap97-20261025-01a1722e-v`.
- Canonical registry: `/Users/junjiexiong/.codex/worktrees/ap-system-integration/calhacks/docs/ap-orchestration/plan.json`; not modified by verifier.
- Runtime: Node `v24.22.0`, Vitest `v5.0.5`. Existing integration `node_modules` was symlinked for reads; test caching disabled. No package install, live credentials, shared backend writes, or persistent service was used. HTTP checks used ephemeral loopback ports and closed every test server.
- Files inspected: `convex/apCasePayments.ts`, `convex/lib/payments/{applyCommand,executionConfig,applyEffect,reservations}.ts`, `convex/lib/demoAuth.ts`, `src/ap-system/{payment,server,service,contracts}.ts`, related original payment contracts, and the tests listed below. The existing engine delta in `applyCommand.ts` and `executionConfig.ts` is one AP-linked authority check in each file; the original lease/recovery engine remains in use.
- Public interface changes made by verifier: none. Changed tracked files: only `docs/ap-orchestration/evidence/V-C1.md`.

## Commands and evidence

Commands ran from the verification worktree unless otherwise indicated. All commands completed with exit code 0.

| Command | Observed result |
| --- | --- |
| `git rev-parse HEAD` | `91198cfae532f75e443bcd39407bb9a76160f1e0` before report creation |
| `npx vitest run tests/ap-case-payments.test.ts tests/payment-kernel.test.ts tests/ap-system-server.test.ts --cache=false` | 3 files, **28 tests passed**; 344 ms; 2026-10-25 01:43:44 local |
| `npx tsc --noEmit` | passed |
| `npx tsc --noEmit -p convex/tsconfig.json` | passed |
| `npx tsc --noEmit -p tsconfig.tests.json` | passed |
| `./node_modules/.bin/vitest run --config /private/tmp/ap97-v-c1/vitest.config.mts --reporter=verbose` | 1 independent harness, **9 tests passed**; 316 ms; 2026-10-25 01:44:48 local |

Total executed: **37 passing tests and 3 passing type checks**. Existing tests use their own scoped in-memory fixtures. The independent tests use the run ID above and are reproduced verbatim in the appendix so this report remains reviewable after temporary files expire.

Independent harness artifacts:

- `/private/tmp/ap97-v-c1/independent.test.ts`, SHA256 `ed523bfdb3ba34025266b6098c9c7f5d063487f9e1d9530f8b0dca39467a2694`.
- `/private/tmp/ap97-v-c1/vitest.config.mts`, SHA256 `1ea91d27ffed8db5e83294bd3fde41f8ea9fc5f0d7ec2e9e63983f19bada5071`.
- Their dependency symlink points to `/Users/junjiexiong/.codex/worktrees/ap-system-integration/calhacks/node_modules`. These tests import the fixed verification worktree, not Master's evolving integration code.

## Verified behavior

| Boundary | Evidence and result |
| --- | --- |
| Preparation is separate from authorization | `apCasePayments.ts:13–24` resolves the current approved/reviewed case to its recognized bill before using the existing request command. Existing component test observed one version and zero commands before the independent human mutation. Retries returned the same version. |
| Case, source-review and payment authority | `apCasePayments.ts:16–19,31–37`, `applyCommand.ts:43–44`, `executionConfig.ts:14–15`. Stale revision/hash, other account scope, other bill version, and a human token with an unbound issuer were rejected. Calling the legacy authorization endpoint after AP review invalidation also failed with zero commands. |
| No client-controlled amount, beneficiary, actor or bank scope | `server.ts:104–107` uses URL IDs and Zod-selected request fields; `service.ts` composes fixed scoped clients. Independent HTTP test supplied conflicting case/version IDs, actor, token, scope, amount and beneficiary; only allowed fields and URL-bound IDs reached service methods. |
| First dispatch checks current authority | Existing AP component test changed review status after authorization; claim returned null and left an exception with `attemptCount=0`. Existing kernel tests also exercised original first-dispatch authorization, cancellation and lease fencing. |
| Possible sends preserve original money identity | Independent test queued an AP-linked Increase-shaped command entirely in memory, claimed it once, then changed case revision/hash, removed review and set a hold. Cancellation and a replacement request failed. After lease expiry, the next claim was `reconcile` with byte-for-byte identical command/provider request, identical key and first attempt time, and generation 2. One command remained; both bill and version reservations remained held. No external Increase API call occurred. |
| No lease/provider secrets in payment audit projection | `apCasePayments.ts:52–55` projects command fields explicitly. An active lease containing a sentinel value and a saved Increase request were absent from serialized detail; the original operation key remained visible. |
| Authenticated exact originals | `server.ts:41–49,71–81` checks session, source ID/revision/hash, byte length/hash, real paths and page bounds. Original access without session failed; changed source bytes and triple mismatches failed; direct and symlink escapes outside the owned source directory failed. |
| Honest raster availability | Missing renderer returned HTTP 503 `preview_unavailable`; an out-of-range page returned 404. This independently supplies the missing assertion in the existing test whose title mentions unavailable raster. |
| HTTP write/session boundary | Missing Origin, cookie or `X-AP-System-Session` each returned 403 before service mutation. Existing cross-origin check passed. |
| Private source artifacts and errors | `server.ts:28–34,112–118` removed original bytes/paths and processor artifact refs without mutating the server-side evidence object. An unexpected provider error containing a sentinel private token yielded a generic rejection, without that token. |

## Actionable follow-ups and acceptance limits

1. **B revision integration must still be exercised.** These component tests seed a reviewed/approved AP row on top of a recognized existing-engine bill; they do not prove B's review, recognition, revision or cancellation workflow. C1's first-dispatch guard prevents dispatch while AP review is invalid, but does not itself perform revision-triggered cancellation. After B is accepted, test the public revision path before authorization, after enqueue but before any attempt, and after a possible send. Before first submission it must cancel/release the old unsent operation; after a possible send it must preserve original key/request/reservations. Fresh review of the new source must not accidentally revive an old authorization. This is an I1/V2 integration requirement, not a reproduced C1 defect.
2. **Real raster/frame correctness remains A/D integration work.** `server.ts:82` delegates raster production to the trusted `renderPage` callback and does not consume its returned frame. Original byte checks and binding headers alone do not prove that the PNG follows the frozen display transform. Exercise rotation, frame mismatch and exact-version highlight behavior with the actual renderer before accepting integrated grounding/UI behavior.
3. **Retain the expanded regression cases.** The independent harness has nine additional tests beyond the committed C1 tests. Master can promote the useful cases to permanent component tests within normal implementation ownership. Verifier was authorized to write only this report in the worktree.
4. **No external or domain acceptance is implied.** No real provider authentication, transfer, parser call, uploaded-PDF-to-ledger flow, fixture expected-outcome review, or practitioner review was performed. V1 awaits its separate assignment after B1 acceptance. The unavailable AP practitioner remains an external acceptance item; this review must stay labeled independent agent engineering verification.

Proposed next action: Master may accept the scoped C1 component evidence, integrate the accepted B implementation, then separately assign integrated I1/V2 verification and the V1 expected-outcome review when their dependencies are accepted. No blocker prevents that progression.

## Appendix: independent harness

Recreate the two files below in `/private/tmp/ap97-v-c1`, link that directory's `node_modules` to the existing dependencies, and run the recorded harness command at the reviewed code SHA. Absolute imports deliberately pin the reviewed worktree. The harness uses synthetic sentinels only.

### vitest.config.mts

```typescript
import { defineConfig } from 'vitest/config';
export default defineConfig({test:{root:'/private/tmp/ap97-v-c1',include:['independent.test.ts'],cache:false}});
```

### independent.test.ts

```typescript
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,symlink,rm} from 'node:fs/promises';
import {makeFunctionReference} from 'convex/server';
import {api,demoFixture} from '/Users/junjiexiong/.codex/worktrees/ap-system-verification/calhacks/tests/demo-fixture';
import {createAPSystemServer,publicCase} from '/Users/junjiexiong/.codex/worktrees/ap-system-verification/calhacks/src/ap-system/server';
const request=makeFunctionReference<'mutation'>('apCasePayments:request');
const authorize=makeFunctionReference<'mutation'>('apCasePayments:authorize');
const detail=makeFunctionReference<'query'>('apCasePayments:detail');
const servers:any[]=[];const dirs:string[]=[];
afterEach(async()=>{vi.useRealTimers();vi.unstubAllEnvs();for(const s of servers.splice(0)){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
async function fixture(increase=false){
 const f=await demoFixture('ap97-20261025-01a1722e-v',increase?{provider:'increase',environment:'sandbox'}:{});
 const billId=await f.bill(67860);
 const caseId=await f.t.run(ctx=>ctx.db.insert('apCaseRecords',{scope:f.scope,primaryHash:'a'.repeat(64),currentRevision:1,snapshotHash:'b'.repeat(64),intake:{},createdBy:'ap_clerk',documentStatus:'reviewed',businessStatus:'approved',fieldReviewId:'verified-component-review',billId,acceptedCents:67860,identityMode:'simulated_human',createdAt:1,updatedAt:1}));
 return {...f,billId,caseId,binding:{scope:f.scope,caseId,expectedRevision:1,snapshotHash:'b'.repeat(64)}};
}
async function prepared(f:any,key='verification-payment'){return f.t.mutation(request,{...f.payments,...f.binding,idempotencyKey:key});}
async function queued(f:any){const p=await prepared(f);const c=await f.human.mutation(authorize,{...f.binding,versionId:p.versionId,paymentSnapshotHash:p.snapshotHash});return {...p,...c};}
const claim=(f:any,leaseToken:string)=>f.t.mutation(api.demoPayments.claim,{scope:f.scope,token:f.dispatcherToken,paymentExecutorVersion:'scoped-ap-v2',workerId:'independent-verifier',leaseToken});
async function httpFixture(){
 const bytes=Buffer.from('verifier original');const sha=createHash('sha256').update(bytes).digest('hex');
 const doc:any={sourceId:'verified-source',revision:1,sha256:sha,name:'source.txt',mimeType:'text/plain',byteLength:bytes.length,originalBase64:bytes.toString('base64'),pageCount:1};
 const service:any={list:vi.fn(async()=>[]),runtime:()=>({runId:'ap97-20261025-01a1722e-v'}),source:vi.fn(async()=>doc),review:vi.fn(async x=>x),approve:vi.fn(),detail:vi.fn(),ingest:vi.fn(),parseUploads:vi.fn(),requestPayment:vi.fn(async x=>x),authorizePayment:vi.fn(async x=>x),paymentDetail:vi.fn()};
 const root=await mkdtemp('/private/tmp/ap97-v-c1/source-');dirs.push(root);
 const server=createAPSystemServer(service,{port:0,runId:'ap97-20261025-01a1722e-v',storageRoot:root,allowedOrigins:['http://127.0.0.1:5190']});servers.push(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}/api/ap-system`;const opened=await fetch(base+'/cases');const cookie=opened.headers.get('set-cookie')!.split(';')[0]!;
 return {doc,service,base,cookie,bytes,sha,root,source:base+`/sources/verified-source/revisions/1?sha256=${sha}`,headers:{cookie,origin:'http://127.0.0.1:5190','X-AP-System-Session':'1','Content-Type':'application/json'}};
}
describe('independent C1 payment verification',()=>{
 it('preserves the Increase request/key/reservations after an AP source revision and possible send',async()=>{
  vi.useFakeTimers();vi.setSystemTime(Date.parse('2026-10-25T12:00:00Z'));
  const f=await fixture(true);const p=await queued(f);const first=await claim(f,'verifier-first-lease-token');expect(first.action).toBe('submit');expect(first.command.providerRequest).toBeTruthy();
  await f.t.run(ctx=>ctx.db.patch(f.caseId,{currentRevision:2,snapshotHash:'c'.repeat(64),documentStatus:'review_required',businessStatus:'held',fieldReviewId:undefined}));
  await expect(f.human.mutation(api.demoPayments.cancel,{scope:f.scope,versionId:p.versionId})).rejects.toThrow();
  await expect(prepared(f,'replacement')).rejects.toThrow(/Stale/);
  vi.setSystemTime(first.leaseExpiresAt+1);const resumed=await claim(f,'verifier-resumed-lease-token');expect(resumed).toMatchObject({action:'reconcile',command:first.command,firstAttemptAt:first.firstAttemptAt,generation:2});
  expect((await f.t.run(ctx=>ctx.db.get(f.billId)))?.reservedVersionId).toBe(p.versionId);expect((await f.t.run(ctx=>ctx.db.get(p.versionId)))?.reservations).toBe('reserved');expect(await f.t.run(ctx=>ctx.db.query('demoCommands').collect())).toHaveLength(1);
  const view=await f.human.query(detail,{scope:f.scope,versionId:p.versionId});const serialized=JSON.stringify(view);expect(serialized).not.toContain('leaseToken');expect(serialized).not.toContain('providerRequest');expect(serialized).not.toContain('verifier-resumed-lease-token');expect(view.command.idempotencyKey).toBe(first.command.idempotencyKey);
 });
 it('blocks an unreviewed original even when authorizing via the legacy entry point',async()=>{
  const f=await fixture();const p=await prepared(f);await f.t.run(ctx=>ctx.db.patch(f.caseId,{documentStatus:'review_required',fieldReviewId:undefined}));
  await expect(f.human.mutation(api.demoPayments.approveAndQueue,{scope:f.scope,...p})).rejects.toThrow(/AP case authority/);expect(await f.t.run(ctx=>ctx.db.query('demoCommands').collect())).toHaveLength(0);
 });
 it('denies stale snapshot, foreign case scope, foreign payment scope and an unbound human',async()=>{
  const f=await fixture();await expect(f.t.mutation(request,{...f.payments,...f.binding,snapshotHash:'d'.repeat(64),idempotencyKey:'stale-hash'})).rejects.toThrow(/Stale/);
  const p=await prepared(f);const badHuman=f.t.withIdentity({subject:'human',issuer:'https://different.invalid',tokenIdentifier:'https://different.invalid|human'});
  await expect(badHuman.mutation(authorize,{...f.binding,versionId:p.versionId,paymentSnapshotHash:p.snapshotHash})).rejects.toThrow(/authenticated human/);
  await f.t.run(ctx=>ctx.db.patch(f.caseId,{scope:{...f.scope,accountId:'different-account'}}));await expect(prepared(f)).rejects.toThrow(/outside account scope/);
  await expect(f.human.query(detail,{scope:{...f.scope,accountId:'different-account'},versionId:p.versionId})).rejects.toThrow(/mismatch/);
 });
 it('cannot reuse a different bill payment key or authorize that version for this case',async()=>{
  const f=await fixture();const otherBill=await f.bill();const p=await f.t.mutation(api.demoPayments.requestPayment,{...f.payments,requestKey:'collision',billIds:[otherBill],credits:[]});
  await expect(prepared(f,'collision')).rejects.toThrow(/idempotency conflict/);await expect(f.human.mutation(authorize,{...f.binding,versionId:p.versionId,paymentSnapshotHash:p.snapshotHash})).rejects.toThrow(/another AP case/);
  expect(await f.t.run(ctx=>ctx.db.query('demoVersions').collect())).toHaveLength(1);expect((await f.t.run(ctx=>ctx.db.get(f.billId)))?.reservedVersionId).toBeUndefined();expect(await f.t.run(ctx=>ctx.db.query('demoCommands').collect())).toHaveLength(0);
 });
});
describe('independent C1 source and HTTP verification',()=>{
 it('rejects exact triple mismatches and missing renderer/page bounds',async()=>{
  const f=await httpFixture();f.doc.sourceId='wrong-source';expect((await fetch(f.source,{headers:{cookie:f.cookie}})).status).toBe(409);f.doc.sourceId='verified-source';
  const wrongHash=f.source.replace(f.sha,'f'.repeat(64));expect((await fetch(wrongHash,{headers:{cookie:f.cookie}})).status).toBe(409);
  const page=f.base+`/sources/verified-source/revisions/1/pages/1?sha256=${f.sha}`;const missing=await fetch(page,{headers:{cookie:f.cookie}});expect(missing.status).toBe(503);expect(await missing.json()).toMatchObject({error:{code:'preview_unavailable'}});
  expect((await fetch(page.replace('/pages/1?','/pages/2?'),{headers:{cookie:f.cookie}})).status).toBe(404);
 });
 it('rejects direct path and symlink escapes from the owned original store',async()=>{
  const f=await httpFixture();const outside=await mkdtemp('/private/tmp/ap97-v-c1/outside-');dirs.push(outside);await writeFile(outside+'/original.txt',f.bytes);delete f.doc.originalBase64;f.doc.originalRef=outside+'/original.txt';
  const direct=await fetch(f.source,{headers:{cookie:f.cookie}});expect(direct.status).toBe(404);expect(await direct.json()).toMatchObject({error:{code:'source_unavailable'}});
  await symlink(outside+'/original.txt',f.root+'/original.txt');f.doc.originalRef=f.root+'/original.txt';expect((await fetch(f.source,{headers:{cookie:f.cookie}})).status).toBe(404);
 });
 it('binds payment requests to URL IDs, stripping asserted actor, scope, amount and beneficiary',async()=>{
  const f=await httpFixture();const body={caseId:'wrong-case',versionId:'wrong-version',expectedRevision:1,snapshotHash:'a'.repeat(64),paymentSnapshotHash:'b'.repeat(64),idempotencyKey:'prepare',scope:{runId:'other'},token:'sentinel-secret',seatId:'human',amountCents:1,destination:{externalAccountId:'evil'}};
  const prepared=await fetch(f.base+'/cases/right-case/payments',{method:'POST',headers:f.headers,body:JSON.stringify(body)});expect(prepared.status).toBe(200);expect(f.service.requestPayment).toHaveBeenCalledWith({caseId:'right-case',expectedRevision:1,snapshotHash:'a'.repeat(64),idempotencyKey:'prepare'});
  const authorized=await fetch(f.base+'/cases/right-case/payments/right-version/authorize',{method:'POST',headers:f.headers,body:JSON.stringify(body)});expect(authorized.status).toBe(200);expect(f.service.authorizePayment).toHaveBeenCalledWith({caseId:'right-case',versionId:'right-version',expectedRevision:1,snapshotHash:'a'.repeat(64),paymentSnapshotHash:'b'.repeat(64)});
 });
 it('requires all write guards and redacts unexpected backend/provider errors',async()=>{
  const f=await httpFixture();const body=JSON.stringify({expectedRevision:1,snapshotHash:'a'.repeat(64),idempotencyKey:'prepare'});
  for(const absent of ['cookie','origin','X-AP-System-Session']){const headers={...f.headers};delete headers[absent];expect((await fetch(f.base+'/cases/case/payments',{method:'POST',headers,body})).status).toBe(403);}
  expect(f.service.requestPayment).not.toHaveBeenCalled();f.service.requestPayment.mockRejectedValue(new Error('provider bearer SENTINEL_PRIVATE_TOKEN'));
  const result=await fetch(f.base+'/cases/case/payments',{method:'POST',headers:f.headers,body});expect(result.status).toBe(409);expect(await result.text()).not.toContain('SENTINEL_PRIVATE_TOKEN');
 });
 it('removes original bytes/private processor artifacts without mutating server evidence',()=>{
  const processor={configArtifact:{ref:'/private/config'},rawArtifact:{ref:'/private/raw'},tokenArtifact:{ref:'/private/tokens'},rasterArtifact:{ref:'/private/raster'},resolvedVersion:'pinned-v1'};
  const original:any={sources:[{originalRef:'/private/original',originalBase64:'private_original_bytes',parser:processor}],candidate:{evidence:[{grounding:{processor}}]},extraction:{evidence:[{grounding:{processor}}]}};
  const result=publicCase(original);const serialized=JSON.stringify(result);expect(serialized).not.toContain('/private/');expect(serialized).not.toContain('private_original_bytes');expect(serialized).toContain('pinned-v1');expect(original.sources[0].originalBase64).toBe('private_original_bytes');expect(original.candidate.evidence[0].grounding.processor.configArtifact.ref).toBe('/private/config');
 });
});
```
