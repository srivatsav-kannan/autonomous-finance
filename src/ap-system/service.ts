import {createQBOCloseBridge} from "./quickbooks/close-runtime";
import type {ConvexHttpClient} from "convex/browser";
import {makeFunctionReference} from "convex/server";
import type {BankScope} from "../payments/contracts";
import {createAPCasePayments} from "./payment";
import {caseDetailSchema,intakeSchema,sourceDocumentSchema,type APIntake,type SourceDocument} from "./contracts";
import { createQBOBridge } from "./quickbooks/runtime";
import { APHttpError } from "./server";
import { domainOperationSchemas, type DomainOperations } from "./domain-operations";
import { closeOperationSchemas,periodSchema,type CloseOperations } from "./close-operations";
import {accountingCorrectionRequestSchema,domainVoteSchema,type CorrectionOperations,type CorrectionProposal} from "./correction-operations";
import type { PaymentRunOperations } from "./workspace-operations";
import type {APWorkspaceService} from "./server";
/** Per-run composition with a request-owned human client in external mode. Agent credentials never reach the browser or human client. */
export function createAPWorkspaceService(options:{
 agent:ConvexHttpClient;human:ConvexHttpClient;scope:BankScope;
 apCredential:{seatId:string;token:string};paymentsCredential:{seatId:string;token:string};controllerCredential?:{seatId:string;token:string};
 parseUploads:APWorkspaceService["parseUploads"];renderPage?:APWorkspaceService["renderPage"];runtime:()=>unknown;
}):APWorkspaceService{
 const{agent,human,scope}=options;const payments=createAPCasePayments(agent,human,scope,options.paymentsCredential);
 const closeQbo=createQBOCloseBridge(human,scope);
 const qbo=createQBOBridge(human,scope),externalWritesAllowed=scope.provider==="increase"&&scope.environment==="sandbox";
 const requireExternal=()=>{if(!externalWritesAllowed)throw new APHttpError("external_accounting_required",403,"External accounting writes and verification require the authenticated Increase sandbox workspace. Local FakeBank supports explicit mapped previews only.");};
 const paymentRuns:PaymentRunOperations={
  list:()=>human.query(makeFunctionReference<"query">("apPaymentRuns:list"),{scope}),
  detail:runId=>human.query(makeFunctionReference<"query">("apPaymentRuns:detail"),{scope,runId}),
  prepare:input=>agent.mutation(makeFunctionReference<"mutation">("apPaymentRuns:prepare"),{scope,...options.paymentsCredential,...input}),
  authorize:input=>human.mutation(makeFunctionReference<"mutation">("apPaymentRuns:authorize"),{scope,...input}),
  cancel:input=>human.mutation(makeFunctionReference<"mutation">("apPaymentRuns:cancel"),{scope,...input}),
 };
 const domain:DomainOperations={
  view:async()=>({...await human.query(makeFunctionReference<"query">("apBusinessConfig:view"),{scope}),controllerProposalAvailable:!!options.controllerCredential}),
  proposals:()=>human.query(makeFunctionReference<"query">("apBusiness:proposals"),{scope}),
  execute:async(operation,input)=>{
   const parsed=domainOperationSchemas[operation].parse(input);
   const credential=operation==="proposePolicy"?options.controllerCredential:operation==="propose"||operation==="proposeSupplier"?options.apCredential:undefined;
   if(operation==="proposePolicy"&&!credential)throw new APHttpError("controller_unavailable",503,"A separate scoped controller agent must be configured before proposing policy.");
   const business=["propose","vote","applyCredits"].includes(operation),nested=operation==="propose"||operation==="vote";
   return (credential?agent:human).mutation(makeFunctionReference<"mutation">(`${business?"apBusiness":"apBusinessConfig"}:${operation}`),{scope,...(credential??{}),...(nested?{input:parsed}:parsed)});
  },
 };
 const close:CloseOperations={
  costState:originalEntryId=>human.query(makeFunctionReference<"query">("apClose:costState"),{scope,originalEntryId}),
  view:async period=>({...await human.query(makeFunctionReference<"query">("apClose:view"),{scope,period:periodSchema.parse(period)}),controllerProposalAvailable:!!options.controllerCredential}),
  execute:async(operation,input)=>{
   const parsed=closeOperationSchemas[operation].parse(input);
   if(operation==="retainEvidence"){
    const {source:binding}=parsed as import("./close-operations").CloseInputs["retainEvidence"];
    const source=sourceDocumentSchema.parse(await human.query(makeFunctionReference<"query">("apCases:source"),{scope,...binding}));
    if(source.sourceId!==binding.sourceId||source.revision!==binding.revision||source.sha256!==binding.sha256)throw new APHttpError("source_binding",409,"The retained original does not match the selected source revision.");
    return agent.mutation(makeFunctionReference<"mutation">("apClose:retainEvidence"),{scope,...options.apCredential,source});
   }
   const proposed=operation==="propose"||operation==="proposeStatement",credential=proposed?options.controllerCredential:undefined;
   if(proposed&&!credential)throw new APHttpError("controller_unavailable",503,"A separate scoped controller agent must be configured before proposing close actions or statements.");
   return (credential?agent:human).mutation(makeFunctionReference<"mutation">(`apClose:${operation}`),{scope,...(credential??{}),...(operation==="proposeStatement"?parsed:{input:parsed})});
  },
 };
 const correctionRows=(caseId:string)=>human.query(makeFunctionReference<"query">("apAccountingCorrections:proposals"),{scope,caseId}) as Promise<CorrectionProposal[]>;
 const corrections:CorrectionOperations={
  creditApplication:(caseId,creditApplicationId)=>human.query(makeFunctionReference<"query">("apAccountingCorrections:creditApplication"),{scope,caseId,creditApplicationId}),
  list:async caseId=>({proposals:await correctionRows(caseId),controllerProposalAvailable:!!options.controllerCredential}),
  propose:async input=>{if(!options.controllerCredential)throw new APHttpError("controller_unavailable",503,"A separate scoped controller agent is required to propose accounting corrections.");return agent.mutation(makeFunctionReference<"mutation">("apAccountingCorrections:propose"),{scope,...options.controllerCredential,input:accountingCorrectionRequestSchema.parse(input)});},
  vote:async(caseId,input)=>{const parsed=domainVoteSchema.strict().parse(input);if(!(await correctionRows(caseId)).some(p=>p._id===parsed.proposalId&&p.caseId===caseId))throw new APHttpError("case_mismatch",409,"This correction proposal is not linked to the selected case.");return human.mutation(makeFunctionReference<"mutation">("apAccountingCorrections:vote"),{scope,input:parsed});},
 };
 return{
  paymentRuns,domain,close,corrections,
  operationalTimings:()=>human.query(makeFunctionReference<"query">("apOperationalMetrics:current"),{scope}),
  closeAccounting:{status:closeQbo.status,preview:closeQbo.preview,submit:(request,hash)=>{requireExternal();return closeQbo.submit(request,hash);},verify:request=>{requireExternal();return closeQbo.verify(request);}},
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
