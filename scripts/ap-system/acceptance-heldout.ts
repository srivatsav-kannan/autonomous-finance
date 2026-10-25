/** Frozen held-out acceptance runner. Runtime inputs: original PDFs, manifest, contexts only. */
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { combineUploads, type TrustedContext } from '../../src/ap-system/ingestion';
import { PARSER_VERSION } from '../../src/ap-system/ingestion/provider';
import { canonical, sha256, saveArtifact, atomicJson } from '../../src/ap-system/ingestion/storage';
import type { APIntake, SourceDocument } from '../../src/ap-system/contracts';
const exec = promisify(execFile);
const args = process.argv.slice(2);
const mode = args[0];
if (!['--live', '--replay'].includes(mode ?? '') || args.length !== (mode === '--live' ? 5 : 3) || args[1] !== '--storage-root' || mode === '--live' && args[3] !== '--provider-env') {
  throw Error('usage_acceptance_heldout_live_or_replay_storage_root_and_live_provider_env');
}
const cwd = process.cwd();
const root = resolve(cwd, args[2]!);
const rel = relative(resolve(cwd, 'var'), root);
if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw Error('private_storage_must_be_inside_worktree_var');
await exec('git', ['check-ignore', '--quiet', root], {cwd});
const fixture = resolve(cwd, 'fixtures/ap-system/heldout-suppliers-v1');
const manifestBytes = await readFile(join(fixture, 'manifest.json'));
const contextBytes = await readFile(join(fixture, 'runtime-contexts.json'));
const manifest = JSON.parse(manifestBytes.toString()) as {
  version:string;
  sources:Array<{id:string;supplierId:string;variant:string;path:string;sha256:string;byteLength:number;mimeType:string;provenance:SourceDocument['provenance']}>;
};
const contexts = JSON.parse(contextBytes.toString()) as Record<string, TrustedContext>;
if (manifest.version !== 'heldout-suppliers-v1' || manifest.sources.length !== 4 || new Set(manifest.sources.map(s=>s.id)).size !== 4) throw Error('frozen_manifest_required');
const codeSha = (await exec('git', ['rev-parse', 'HEAD'], {cwd})).stdout.trim();
const changes = (await exec('git', ['diff', 'HEAD', '--', 'src/ap-system/ingestion'], {cwd})).stdout;
if (changes) throw Error('modified_runtime_refused');
const traineddataPath = '/opt/homebrew/share/tessdata/eng.traineddata';
const traineddataSha256 = sha256(await readFile(traineddataPath));
if (traineddataSha256 !== '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2') throw Error('unexpected_traineddata');
const ocr = {traineddataPath,tesseractPath:'/opt/homebrew/bin/tesseract',pdfinfoPath:'/opt/homebrew/bin/pdfinfo',pdftoppmPath:'/opt/homebrew/bin/pdftoppm',timeoutMs:20000,maxPages:8};
let apiKey: string | undefined;
if (mode === '--live') {
  // Parse only this authorized key. Never source the file or put its other variables into process.env.
  const providerFile = resolve(args[4]!);
  const metadata = await stat(providerFile);
  if ((metadata.mode & 0o077) !== 0) throw Error('provider_file_must_be_private');
  const content = await readFile(providerFile, 'utf8');
  const matches = content.split(/\r?\n/).map(line => /^\s*(?:export\s+)?LLAMA_CLOUD_API_KEY\s*=\s*(.*?)\s*$/.exec(line)).filter(Boolean);
  if (matches.length !== 1) throw Error('single_llama_key_required');
  let value = matches[0]![1]!;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value=value.slice(1,-1);
  if (!value || /[\r\n\s]/.test(value)) throw Error('invalid_llama_key');
  apiKey=value;
}
await mkdir(root,{recursive:true,mode:0o700});
const run = {mode:mode==='--live'?'initial':'replay',startedAt:new Date().toISOString(),codeSha,manifestSha256:sha256(manifestBytes),contextSha256:sha256(contextBytes),parserVersion:PARSER_VERSION,ocr,traineddataSha256,readsEvaluation:false,readsAuthoring:false};
const results: unknown[]=[];
for (const source of manifest.sources) {
  const file=resolve(fixture,source.path);
  const inputRel=relative(join(fixture,'input'),file);
  if (inputRel.startsWith('..') || isAbsolute(inputRel) || source.mimeType!=='application/pdf') throw Error('original_path_refused');
  const bytes=await readFile(file);
  if (bytes.length!==source.byteLength || sha256(bytes)!==source.sha256) throw Error('original_hash_changed');
  const context=contexts[source.supplierId];
  if (!context || Object.keys(context).some(k=>!['supplier','coding'].includes(k)) || context.supplier?.supplierId!==source.supplierId || !context.supplier.legalName || !context.coding) throw Error('bounded_runtime_context_required');
  const storageRoot=join(root,source.id);
  await mkdir(storageRoot,{recursive:true,mode:0o700});
  const initialPath=join(storageRoot,'initial.intake.private.json');
  if (mode==='--live' && await stat(initialPath).then(()=>true,()=>false)) throw Error('initial_result_exists_use_replay');
  const traces: unknown[]=[];
  let posts=0, reads=0;
  const fetcher: typeof fetch = async (url,init) => {
    if (mode!=='--live') throw Error('offline_network_forbidden');
    const parsed=new URL(String(url));
    const isApi=parsed.origin==='https://api.cloud.llamaindex.ai' && parsed.pathname.startsWith('/api/v2/parse/');
    const method=init?.method ?? 'GET';
    if (method==='POST') posts++; else reads++;
    console.log(JSON.stringify({source:source.id,stage:method==='POST'?'provider_submit':'provider_read',request:posts+reads}));
    const response=await fetch(url,init);
    const reader=response.body?.getReader();
    const chunks: Uint8Array[]=[];let length=0;
    if (reader) try {
      while(true) {
        const part=await reader.read();if(part.done)break;
        length+=part.value.byteLength;
        if(length>40*1024*1024){await reader.cancel();throw Error('acceptance_response_too_large');}
        chunks.push(part.value);
      }
    } finally {reader.releaseLock();}
    const body=Buffer.concat(chunks);
    const raw=await saveArtifact(storageRoot,body,'http');
    traces.push({index:traces.length+1,at:new Date().toISOString(),kind:isApi?(method==='POST'?'upload':'job_read'):'artifact_download',method,status:response.status,byteLength:length,raw});
    await atomicJson(join(storageRoot,'http.private.json'),traces);
    return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
  };
  const idempotencyKey='heldout-v1-'+source.id+'-intake-1';
  const request={uploads:[{bytes,name:file.split('/').at(-1)!,mimeType:source.mimeType,sourceId:'heldout-v1-'+source.id,revision:1,deliveryId:'heldout-v1-'+source.id+'-delivery-1',kind:'invoice' as const,provenance:source.provenance}],storageRoot,idempotencyKey,context,options:{apiKey,fetcher,parserVersion:PARSER_VERSION,maxPollMs:180000,pollMs:1500,ocr}};
  console.log(JSON.stringify({source:source.id,stage:'starting',mode:run.mode}));
  let intake: APIntake | null=null;
  let errorCode:string|null=null;
  try {intake=await combineUploads(request);} catch(error) {
    errorCode=error instanceof Error && /^[a-z][a-z0-9_]+$/.test(error.message)?error.message:'acceptance_runner_failure';
    await atomicJson(join(storageRoot,run.mode+'.failure.private.json'),{code:errorCode,message:error instanceof Error?error.message:String(error)});
  }
  let replayMatch:boolean|null=null;
  const intakeJson=JSON.stringify(intake,null,2)+'\n';
  if(mode==='--live') await writeFile(initialPath,intakeJson,{flag:'wx',mode:0o600});
  else {
    const initial=JSON.parse(await readFile(initialPath,'utf8'));
    replayMatch=canonical(initial)===canonical(intake);
    await writeFile(join(storageRoot,'replay.intake.private.json'),intakeJson,{flag:'wx',mode:0o600});
  }
  const jobs: unknown[]=[];
  for(const dirname of await readdir(join(storageRoot,'jobs')).catch(()=>[] as string[])) {
    const state=JSON.parse(await readFile(join(storageRoot,'jobs',dirname,'state.json'),'utf8'));
    jobs.push({jobId:state.jobId,status:state.status,sourceSha256:state.sourceSha256,configHash:state.configHash,resultArtifact:state.resultArtifact,groundedArtifact:state.groundedArtifact,wordsArtifact:state.wordsArtifact,processor:state.processor});
  }
  const evidence=intake?.extraction.evidence ?? [];
  const count=(values:string[])=>Object.fromEntries([...new Set(values)].sort().map(v=>[v,values.filter(x=>x===v).length]));
  const row={source:source.id,sourceSha256:source.sha256,localCaseKey:idempotencyKey,storageDirectory:source.id,intakeSha256:sha256(intakeJson),errorCode,candidatePresent:Boolean(intake?.candidate),extractionStatus:intake?.extraction.status ?? 'runner_failed',reasons:intake?.extraction.reasons ?? [errorCode],pageStatus:intake?.documents[0]?.pageStatus ?? [],evidenceCount:evidence.length,contentStatus:count(evidence.map(e=>e.contentStatus)),geometryStatus:count(evidence.map(e=>e.grounding.status)),geometryMethods:count(evidence.map(e=>e.grounding.method)),unresolved:evidence.filter(e=>e.grounding.status==='unresolved').map(e=>({fieldPath:e.fieldPath,reason:e.grounding.failureReason})),processors:[...new Map(evidence.map(e=>[e.grounding.processor.configHash,e.grounding.processor])).values()],posts,reads,jobs,replayMatch};
  results.push(row);
  await atomicJson(join(root,run.mode+'.report.private.json'),{...run,completedAt:new Date().toISOString(),results});
  console.log(JSON.stringify({source:source.id,stage:'retained',candidatePresent:row.candidatePresent,extractionStatus:row.extractionStatus,errorCode,posts,reads,replayMatch}));
}
console.log(JSON.stringify({stage:'complete',mode:run.mode,sources:results.length,report:join(root,run.mode+'.report.private.json')}));
