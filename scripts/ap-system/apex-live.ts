/** Start an empty live APEX run; document work begins only from the UI action. */
import { spawn } from "node:child_process";
const runId = process.env.APEX_RUN_ID ?? `apex107-live-${new Date().toISOString().slice(0,10).replaceAll("-","")}-${Date.now().toString(36)}`;
if (!/^apex107-live-[0-9]{8}-[a-z0-9-]{1,40}$/.test(runId)) throw Error("APEX_RUN_ID must identify a local APEX live run");
const env: NodeJS.ProcessEnv = {PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,AGENT_LLM:"off",APEX_RUN_ID:runId};
if (process.env.APEX_WORLD_ROOT) env.APEX_WORLD_ROOT = process.env.APEX_WORLD_ROOT;
console.log(`Starting empty run ${runId}. Open http://127.0.0.1:5192/ap-system?view=ap-system&apRuntime=apex and select Process invoice PDFs.`);
const child = spawn(process.execPath,["--import","tsx","scripts/ap-system/apex-replay.ts","serve"],{stdio:"inherit",env});
for (const signal of ["SIGINT","SIGTERM"] as const) process.once(signal,()=>child.kill(signal));
child.once("exit",code=>process.exit(code ?? 1));
