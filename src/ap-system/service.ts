import type {ConvexHttpClient} from "convex/browser";
import {makeFunctionReference} from "convex/server";
import type {BankScope} from "../payments/contracts";
import {createAPCasePayments} from "./payment";
import {caseDetailSchema,intakeSchema,type APIntake,type SourceDocument} from "./contracts";
import type {APWorkspaceService} from "./server";
/** Per-run composition with a request-owned human client in external mode. Agent credentials never reach the browser or human client. */
export function createAPWorkspaceService(options:{
 agent:ConvexHttpClient;human:ConvexHttpClient;scope:BankScope;
 apCredential:{seatId:string;token:string};paymentsCredential:{seatId:string;token:string};
 parseUploads:APWorkspaceService["parseUploads"];renderPage?:APWorkspaceService["renderPage"];runtime:()=>unknown;
}):APWorkspaceService{
 const{agent,human,scope}=options;const payments=createAPCasePayments(agent,human,scope,options.paymentsCredential);
 return{
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
