import {afterEach,it,expect,vi} from "vitest";
import {DemoWorkspaceNav} from "../console/src/DemoWorkspaceNav";
afterEach(()=>vi.unstubAllGlobals());
import {renderToStaticMarkup} from "react-dom/server";
import {APSystemWork,APWorkDiff} from "../console/src/APSystemWork";
import {APHistory} from "../console/src/APSystemWorkspace";
import {APPrecedentRule,APPrecedentResults} from "../console/src/APSystemLearning";
import type {APWorkTransition} from "../src/ap-system/work-contracts";
import type {PrecedentCandidate,PrecedentEvaluation} from "../src/ap-system/precedent-contracts";
import {apUIFixture} from "./ap-system-ui.fixture";
const snapshot={status:"waiting" as const,stage:"agent_missing_evidence",owner:"human:receiving",role:"ap_clerk" as const,reason:"Receipt required",requirements:["receipt"],generation:2,waitSince:1000,deadlineAt:null};
it("shows persisted ownership and explicit bank boundary, never invents an absent work record",()=>{
 const detail=apUIFixture();const absent=renderToStaticMarkup(<APSystemWork detail={detail} busy={false} onBusy={()=>{}} onChanged={()=>{}}/>);expect(absent).toContain("no persisted agent work record");expect(absent).not.toContain("Pause case agent");
 detail.work={...snapshot,workId:"work-1",caseId:detail.caseId,version:"ap-work-v1",updatedAt:1000};const html=renderToStaticMarkup(<APSystemWork detail={detail} busy={false} onBusy={()=>{}} onChanged={()=>{}}/>);expect(html).toContain("human:receiving");expect(html).toContain("Receipt required");expect(html).toContain("does not cancel or stop an already authorized bank transfer");expect(html).toContain('disabled="">Pause case agent');
});
it("labels legacy summaries and renders recorded diffs including denied outcomes",()=>{
 const detail=apUIFixture();detail.timeline=[{eventId:"legacy",at:1000,actor:"human",kind:"review",summary:"Reviewed",references:[]}];expect(renderToStaticMarkup(<APHistory detail={detail}/>)).toContain("Legacy summary");
 const transition:APWorkTransition={contractVersion:"ap-work-v1",workId:"work-1",operationId:"op-1",action:"paused",actorKind:"human",authority:"current owner",workerVersion:"v1",policyVersion:"policy-v1",caseRevision:1,snapshotHash:"a".repeat(64),sourceBindings:[],before:snapshot,after:{...snapshot,status:"paused"},changes:[{field:"status",before:"waiting",after:"paused"}],outcome:"committed"};
 const html=renderToStaticMarkup(<APWorkDiff transition={transition}/>);expect(html).toContain("Recorded state changes");expect(html).toContain("Before");expect(html).toContain("waiting");expect(html).toContain("paused");expect(html).toContain("op-1");expect(html).toContain("Policy version");expect(html).toContain("policy-v1");
 expect(html).toContain("No model decision is attached");
 const model=renderToStaticMarkup(<APWorkDiff transition={{...transition,decision:{version:"ap-model-decision-v1",runId:"model-run",mode:"model",provider:"openai",model:"test-model",action:"wait",reason:"Receipt evidence missing",evidenceIds:["receipt-field"],inspectedRevision:1,inspectedSnapshotHash:"a".repeat(64),inputHash:"c".repeat(64),usage:{inputTokens:20,outputTokens:10,costMicros:20},latencyMs:40}}}/>);expect(model).toContain("Recorded model decision: Wait");expect(model).toContain("Receipt evidence missing");expect(model).toContain("test-model");expect(model).toContain("Configured cost estimate");
 expect(renderToStaticMarkup(<APWorkDiff transition={{...transition,outcome:"denied",changes:[]}}/>)).toContain("Denied attempt: no state change");
});
it("keeps candidate rules inactive without policy and keeps recommendations distinct from financial actions",()=>{
 const candidate:PrecedentCandidate={id:"rule",hash:"b".repeat(64),scope:{supplierId:"supplier",category:"cleaning",locations:["store"],effectiveFrom:"2026-01-01",effectiveUntil:"2026-12-31"},coding:{accountCode:"5000",allocations:[{dimension:"store",code:"store",basisPoints:10000}]},historyIds:["history"],reason:"Correction evidence",status:"proposed",support:[],contradictions:[],missingContext:["Limited history"],inferenceMode:"deterministic_demo",proposedBy:"agent",createdAt:1000,humanReview:null};
 const html=renderToStaticMarkup(<APPrecedentRule candidate={candidate} policyReady={false} reviewGroup={null} busy={false} onReview={async()=>{}}/>);expect(html).toContain("rule remains inactive");expect(html).toContain('fieldset class="aps-business-editor" disabled=""');expect(html).toContain("Limited history");expect(html).toContain("historical correction alone cannot activate");
 const evaluation:PrecedentEvaluation={id:"eval",context:{supplierId:"supplier",category:"cleaning",location:"store",effectiveOn:"2026-10-25",currency:"USD",amountCents:7700},status:"recommendation",coding:candidate.coding,ruleIds:["rule"],reason:"Approved scope matches",requiresHumanReview:true,evaluatedAt:1000,inferenceMode:"deterministic_demo"};
 const result=renderToStaticMarkup(<APPrecedentResults evaluations={[evaluation,{...evaluation,id:"held",status:"held",coding:null,ruleIds:[],reason:"Outside approved scope"}]}/>);expect(result).toContain("Coding recommendation");expect(result).toContain("Held for review");expect(result).toContain("creates no bill, journal or bank transfer");expect(result).toContain("No approved rule was used");
});

it("links learning on the current origin and preserves only an active APEX runtime",()=>{
 const localLocation={pathname:"/ap-system",search:"?apWorkspace=learning"};vi.stubGlobal("location",localLocation);vi.stubGlobal("window",{location:localLocation});
 const local=renderToStaticMarkup(<DemoWorkspaceNav/>);expect(local).toContain('aria-current="page" href="/ap-system?view=ap-system&amp;apWorkspace=learning">Learning &amp; demo');expect(local).not.toContain("5196");
 const apexLocation={pathname:"/ap-system",search:"?apRuntime=apex"};vi.stubGlobal("location",apexLocation);vi.stubGlobal("window",{location:apexLocation});
 const apex=renderToStaticMarkup(<DemoWorkspaceNav busy/>);expect(apex).toContain('href="/ap-system?view=ap-system&amp;apWorkspace=learning&amp;apRuntime=apex"');expect(apex).toContain('aria-disabled="true"');
});
