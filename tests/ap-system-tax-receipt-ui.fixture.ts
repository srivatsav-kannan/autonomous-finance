import type {QBOCloseStatus} from "../src/ap-system/quickbooks/close-runtime";
import type {Plan} from "../src/ap-system/quickbooks/types";
import {closeUIFixture} from "./ap-system-close-ui.fixture";
export type TaxReceiptScenario={authority:"current"|"historical_receipt_only";state:"prepared"|"sending"|"unknown"|"succeeded";reads:boolean};
export const taxReceiptActionId="synthetic-tax-receipt-action";
export function taxReceiptUIFixture(scenario:TaxReceiptScenario){
 const view=closeUIFixture(),journalId="synthetic-tax-receipt-journal",exportId=`tax_reclassification:${journalId}`,hash="d".repeat(64),at=1793491200000;
 view.accrualApplications=[];
 view.actions=[{_id:taxReceiptActionId,kind:"tax_adjustment",payload:{kind:"tax_adjustment",originalEntryId:"synthetic-original-journal",originalApprovalId:"synthetic-original-approval",costSnapshotHash:"c".repeat(64),taxSnapshotHash:"e".repeat(64),initialAttribution:[],targets:[{originalLineId:"synthetic-line",recoverableCents:425}],movements:[{from:{originalLineId:"synthetic-line",allocationIndex:1,account:"1180",treatment:"tax",store:null,department:"synthetic-operations",project:null,amountCents:425},toAccount:"5000",toTreatment:"expense"}],date:"2026-10-31",eligibilityEvidence:[{source:{sourceId:"synthetic-eligibility",revision:1,sha256:"f".repeat(64)},page:1,start:0,end:9,quote:"Synthetic",rawValue:"Synthetic"}],reason:"Synthetic historical-receipt component example"},hash,amountCents:425,route:[],stage:0,votes:[],status:"approved",proposedBy:"synthetic-controller",createdAt:at,entryId:journalId}];
 const plan:Plan={version:"ap-qbo-operation-v1",realmId:"synthetic-company",minorVersion:75,entity:"JournalEntry",identity:"synthetic-existing-tax-request",mappingHash:"a".repeat(64),links:{caseId:"synthetic-case",billId:"synthetic-bill",closeExportId:exportId,closeJournalId:journalId,closeActionId:taxReceiptActionId,recognitionJournalId:"synthetic-original-journal",originalJournalId:"synthetic-original-journal",paymentVersionId:null,commandId:null,bankTransactionId:null,settlementJournalId:null,creditId:null},payload:{TxnDate:"2026-10-31",Line:[{Amount:4.25,JournalEntryLineDetail:{PostingType:"Debit",AccountRef:{value:"synthetic-cost-account"}}},{Amount:4.25,JournalEntryLineDetail:{PostingType:"Credit",AccountRef:{value:"synthetic-tax-account"}}}]}};
 const historical=scenario.authority==="historical_receipt_only";
 const status:QBOCloseStatus={authority:scenario.authority,externalWritesAllowed:!historical,externalReadsAllowed:scenario.reads,configuration:"configured",grant:"available",mappings:historical?"missing":"configured",exportId,receipts:[{entity:"JournalEntry",requestId:plan.identity,state:scenario.state,externalId:scenario.state==="succeeded"?"synthetic-existing-external-journal":null,syncToken:scenario.state==="succeeded"?"0":null,links:plan.links,updatedAt:at,lastError:scenario.state==="unknown"?"synthetic_response_unknown":null,...(scenario.state!=="prepared"?{submissionAuthorization:{subject:"synthetic-original-human",planHash:hash,decidedAt:at}}:{})}],holds:historical?[{state:"held",owner:"controller",code:"historical_receipt_only",reason:"Synthetic policy-retirement example: no current authority to preview or submit; existing receipt remains inspectable.",realmId:plan.realmId,exportId,request:{actionId:taxReceiptActionId},createdAt:at}]:[],complete:true,externalVerification:"not_checked"};
 return{view,status,plan,planHash:hash};
}
/** Fixture-owned transport: never forwards requests and never changes an economic state. */
export function taxReceiptFixtureResponse(scenario:TaxReceiptScenario,path:string,method:string,body:unknown){
 const data=body as {request?:{actionId?:string;accrualApplicationId?:string}}|undefined;
 const error=(code:string,reason:string,status=409)=>({status,value:{error:{code,reason}}});
 if(method!=="POST"||data?.request?.actionId!==taxReceiptActionId||data.request.accrualApplicationId)return error("fixture_unavailable","Only the exact synthetic tax action is available.",503);
 const fixture=taxReceiptUIFixture(scenario);
 if(path==="/api/ap-system/close/accounting/status")return{status:200,value:fixture.status};
 if(path==="/api/ap-system/close/accounting/preview"&&scenario.authority==="current")return{status:200,value:{plan:fixture.plan,planHash:fixture.planHash,externalWrites:0}};
 if(path==="/api/ap-system/close/accounting/verify")return error("fixture_no_provider_read","Synthetic verify click recorded locally. No provider was contacted and this receipt remains unchanged.");
 return error("fixture_no_financial_action","This read-only component fixture never submits, sends or changes a journal.",403);
}
