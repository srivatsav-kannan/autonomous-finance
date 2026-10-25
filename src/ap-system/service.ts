import type {ConvexHttpClient} from "convex/browser";
import {makeFunctionReference} from "convex/server";
import type {BankScope} from "../payments/contracts";
import {createAPCasePayments} from "./payment";
import {caseDetailSchema,intakeSchema,type APIntake,type SourceDocument} from "./contracts";
import { createQBOBridge } from "./quickbooks/runtime";
import { APHttpError } from "./server";
import type { PaymentRunOperations } from "./workspace-operations";
import type {APWorkspaceService} from "./server";
/** Per-run composition with a request-owned human client in external mode. Agent credentials never reach the browser or human client. */
export function createAPWorkspaceService(options:{
 agent:ConvexHttpClient;human:ConvexHttpClient;scope:BankScope;
 apCredential:{seatId:string;token:string};paymentsCredential:{seatId:string;token:string};
 parseUploads:APWorkspaceService["parseUploads"];renderPage?:APWorkspaceService["renderPage"];runtime:()=>unknown;
}):APWorkspaceService{
 const{agent,human,scope}=options;const payments=createAPCasePayments(agent,human,scope,options.paymentsCredential);
 const qbo=createQBOBridge(human,scope),externalWritesAllowed=scope.provider==="increase"&&scope.environment==="sandbox";
 const requireExternal=()=>{if(!externalWritesAllowed)throw new APHttpError("external_accounting_required",403,"External accounting writes and verification require the authenticated Increase sandbox workspace. Local FakeBank supports explicit mapped previews only.");};
 const paymentRuns:PaymentRunOperations={
  list:()=>human.query(makeFunctionReference<"query">("apPaymentRuns:list"),{scope}),
  detail:runId=>human.query(makeFunctionReference<"query">("apPaymentRuns:detail"),{scope,runId}),
  prepare:input=>agent.mutation(makeFunctionReference<"mutation">("apPaymentRuns:prepare"),{scope,...options.paymentsCredential,...input}),
  authorize:input=>human.mutation(makeFunctionReference<"mutation">("apPaymentRuns:authorize"),{scope,...input}),
  cancel:input=>human.mutation(makeFunctionReference<"mutation">("apPaymentRuns:cancel"),{scope,...input}),
 };
 return{
  paymentRuns,
  accounting:{status:async caseId=>({...await qbo.status(caseId),externalWritesAllowed}),preview:qbo.preview,submit:(request,hash)=>{requireExternal();return qbo.submit(request,hash);},verify:request=>{requireExternal();return qbo.verify(request);}},
  async list(){const rows=await human.query(makeFunctionReference<"query">("apCases:list"),{scope});return caseDetailSchema.array().parse(rows);},
  async detail(caseId){return caseDetailSchema.parse(await human.query(makeFunctionReference<"query">("apCases:detail"),{scope,caseId}));},
  async ingest(input:APIntake){return agent.mutation(makeFunctionReference<"mutation">("apCases:ingest"),{scope,...options.apCredential,input:intakeSchema.parse(input)});},
  parseUploads:options.parseUploads,
  review:input=>human.mutation(makeFunctionReference<"mutation">("apCases:reviewFields"),{scope,input}),
  approve:input=>human.mutation(makeFunctionReference<"mutation">("apCases:approveBill"),{scope,input}),
  requestPayment:input=>payments.request(input),authorizePayment:input=>payments.authorize(input),paymentDetail:versionId=>payments.detail(versionId),
  cancelPayment:input=>human.mutation(makeFunctionReference<"mutation">("apCasePayments:cancel"),{scope,...input}),
  source:async(sourceId,revision,sha256)=>human.query(makeFunctionReference<"query">("apCases:source"),{scope,sourceId,revision,sha256}) as Promise<SourceDocument>,
  renderPage:options.renderPage,runtime:options.runtime,
 };
}
