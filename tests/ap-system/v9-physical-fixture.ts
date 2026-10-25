import {createHash} from 'node:crypto';
import {makeFunctionReference} from 'convex/server';
import type {APCaseDetail,APIntake,SourceDocument} from '../../src/ap-system/contracts';
import type {PhysicalLine,PhysicalMappingProposal} from '../../src/ap-system/physical-line-contracts';
import type {CloseAction,PeriodView} from '../../src/ap-system/close-contracts';
import {businessFixture,policy,subject,binding,acceptance,syncPrimary} from './business-fixture';
import {packet} from './accounting-fixture';
export const physicalRef=(n:string)=>makeFunctionReference<'mutation'>(`apPhysicalLines:${n}`);
export const closeRef=(n:string)=>makeFunctionReference<'mutation'>(`apClose:${n}`);
export const physicalView=makeFunctionReference<'query'>('apPhysicalLines:view');
export const periodView=makeFunctionReference<'query'>('apClose:view');
export const originalLines=['North receiving KALE-24 0.5 case accepted','South receiving KALE-24 1.5 case accepted'];
export const physical:PhysicalLine[]=originalLines.map((quote,i)=>({physicalLineId:i?'south':'north',sku:'KALE-24',unit:'case',capacity:i?'1.5':'0.5',unitPriceCents:null,locator:{page:1,start:i?originalLines[0]!.length+1:0,end:(i?originalLines[0]!.length+1:0)+quote.length,quote}}));
export function setOriginal(doc:SourceDocument,body:string){Object.assign(doc,{extractedText:body,originalBase64:Buffer.from(body).toString('base64'),byteLength:Buffer.byteLength(body),sha256:createHash('sha256').update(body).digest('hex')});}
export function physicalPacket(number='V9-one',style:'split'|'merged'|'resplit'|'reordered'='split'){
 const input=packet(number),doc=input.documents[2]!,p=input.purchasingEvidence[1]!,template=p.lines[0]!;
 setOriginal(doc,originalLines.join('\n'));p.source=binding(doc);
 const rows=style==='merged'?[['merged','2']]:style==='resplit'?[['north-left','0.25'],['north-right','0.25'],['south','1.5']]:[['north','0.5'],['south','1.5']];
 p.lines=rows.map(([id,qty])=>({...template,lineId:`${number}-${id}`,quantity:{decimal:qty!,unit:'case'}}));if(style==='reordered')p.lines.reverse();return syncPrimary(input);
}
export async function physicalFixture(initial:APIntake=physicalPacket()){
 const p=policy();p.groups.push({groupId:'identity-review',members:[subject('second'),subject('delegate')]});p.receiptIdentityApprovalGroup='identity-review';
 const f=await businessFixture({policy:p,input:initial});let seq=0;
 function links(input:APIntake){return input.purchasingEvidence[1]!.lines.flatMap(row=>row.lineId.endsWith('merged')?physical.map(p=>({parserLineId:row.lineId,physicalLineId:p.physicalLineId,quantity:p.capacity})):[{parserLineId:row.lineId,physicalLineId:/-north(?:-(?:left|right))?$/.test(row.lineId)?'north':'south',quantity:row.quantity.decimal}]);}
 const mapping=(input=f.input,detail=f.detail,catalogId?:string,patch:Partial<PhysicalMappingProposal>={})=>f.t.mutation(physicalRef('propose'),{...f.controller,idempotencyKey:`v9-map-${++seq}`,proposal:{caseId:detail.caseId,expectedRevision:detail.revision,snapshotHash:detail.snapshotHash,source:input.purchasingEvidence[1]!.source,...(catalogId?{catalogId}:{physicalLines:physical}),links:links(input),reason:'Independent original-derived physical allocation',...patch}});
 const approveMapping=(m:{reviewId:string;hash:string},who='second',outcome='approved')=>f.humans[who]!.mutation(physicalRef('decide'),{scope:f.scope,input:{reviewId:m.reviewId,expectedHash:m.hash,outcome,reason:'Independently compared both original spans and conserved quantities'}});
 function accepted(input:APIntake,reviewId:string,selection:('north'|'south')[]=['north','south']){
  const a=acceptance(input,String(selection.reduce((n,id)=>n+(id==='north'?0.5:1.5),0))),p=input.purchasingEvidence[1]!;
  a.lines[0]!.receipts=p.lines.filter(row=>row.lineId.endsWith('merged')||selection.some(id=>row.lineId.endsWith('-'+id)||row.lineId.endsWith('-'+id+'-left')||row.lineId.endsWith('-'+id+'-right'))).map(row=>({source:p.source,lineId:row.lineId,quantity:row.lineId.endsWith('merged')?a.lines[0]!.quantity:row.quantity.decimal,identity:{reviewId,allocations:row.lineId.endsWith('merged')?selection.map(id=>({physicalLineId:id,quantity:id==='north'?'0.5':'1.5'})):[{physicalLineId:/-north(?:-(?:left|right))?$/.test(row.lineId)?'north':'south',quantity:row.quantity.decimal}]}}));return a;
 }
 const view=()=>f.humans.finance!.query(periodView,{scope:f.scope,period:'2026-10'}) as Promise<PeriodView>;
 const proposeClose=(action:CloseAction)=>f.t.mutation(closeRef('propose'),{...f.controller,input:{idempotencyKey:`v9-close-${++seq}`,action}});
 async function approveClose(action:CloseAction){const pr=await proposeClose(action);let result:any;for(const step of pr.route){const who=step.groupId==='govern'?'governor':step.groupId==='owner'?'owner':'finance';result=await f.humans[who]!.mutation(closeRef('vote'),{scope:f.scope,input:{actionId:pr.actionId,actionHash:pr.actionHash,idempotencyKey:`v9-vote-${++seq}`,outcome:'approved',reason:'Independent exact amount, source and date review'}});}return{pr,result};}
 async function retain(text:string,kind:SourceDocument['kind']='other'){const doc=structuredClone(f.input.documents[0]!);Object.assign(doc,{sourceId:`v9-retained-${++seq}`,deliveryId:`v9-retained-delivery-${seq}`,name:`v9-${seq}.txt`,kind,mimeType:'text/plain'});setOriginal(doc,text);return f.t.mutation(closeRef('retainEvidence'),{...f.controller,source:doc});}
 const snapshot=()=>f.t.run(async ctx=>({catalogs:await ctx.db.query('apPhysicalSources').collect(),mappings:await ctx.db.query('apPhysicalLineReviews').collect(),uses:await ctx.db.query('apReceiptConsumptions').collect(),accruals:await ctx.db.query('apAccruals').collect(),applications:await ctx.db.query('apAccrualApplications').collect(),journals:await ctx.db.query('journalEntries').collect(),bills:await ctx.db.query('demoBills').collect(),credits:await ctx.db.query('demoCredits').collect()}));
 return{...f,mapping,approveMapping,accepted,view,proposeClose,approveClose,retain,snapshot};
}
