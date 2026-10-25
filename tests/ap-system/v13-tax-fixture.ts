import {packet} from './accounting-fixture';
import {businessFixture,policy,subject,acceptance,binding,br,syncPrimary} from './business-fixture';
import {setText,cite,syntheticTaxRule,taxEvidenceFixture} from './tax-fixture';
import type {BusinessAcceptance,CreditPlan} from '../../src/ap-system/domain-contracts';
import type {TaxClaim} from '../../src/ap-system/tax-contracts';

/** Independent two-SKU declared tax-base example; synthetic originals, never tax advice. */
export async function headerFixture() {
  const input=packet('V13-TWO-LINE-HEADER'),c=input.candidate!;
  const first=c.lines[0]!;first.quantity.decimal='3';first.unitPriceCents=500;first.amountCents=1500;first.taxCents=165;first.allocations[0]!.amountCents=1665;
  const second=structuredClone(first);second.lineId='line-2';second.sku='LETTUCE-12';second.description='Synthetic lettuce';second.quantity.decimal='2';second.amountCents=1000;second.taxCents=105;second.allocations[0]!.amountCents=1105;c.lines.push(second);
  c.subtotalCents=2500;c.taxCents=270;c.freightCents=300;c.discountCents=100;c.totalCents=2970;
  c.freightAllocations=[{...first.allocations[0]!,amountCents:300}];c.discountAllocations=[{...first.allocations[0]!,amountCents:100}];
  for(const [i,p] of input.purchasingEvidence.entries()) {
    p.lines[0]!.quantity.decimal='3';p.lines[0]!.unitPriceCents=500;
    p.lines.push({...structuredClone(p.lines[0]!),lineId:`support-${i}-2`,invoiceLineId:'line-2',sku:'LETTUCE-12',quantity:{decimal:'2',unit:'case'},unitPriceCents:500});
    setText(input.documents[i+1]!,`Independent ${p.kind}: KALE-24 3 case at 500; LETTUCE-12 2 case at 500. Accepted receiver 2026-10-19.`);p.source=binding(input.documents[i+1]!);
  }
  syncPrimary(input);
  const doc=input.documents[0]!;
  setText(doc,`${doc.extractedText}\nKALE net $15.00 tax $1.65\nLETTUCE net $10.00 tax $1.05\nFreight $3.00 discount $1.00\nRate 10%\nTax point 2026-10-19\nPricing tax exclusive\nJurisdiction SYNTHETIC-JURISDICTION`);
  c.evidence.forEach(e=>e.source=binding(doc));
  const eligibility=taxEvidenceFixture().documents.at(-1)!;input.documents.push(eligibility);c.sources=input.documents.map(binding);
  const p=policy();p.version='v13-independent-tax';p.groups.push({groupId:'tax-review',members:[subject('second')]});p.accounts.push({account:'1180',treatment:'tax'});
  p.bands=[{upToCents:Number.MAX_SAFE_INTEGER,steps:[{groupId:'owner',quorum:1,escalateAfterMs:60000,escalationGroupId:null},{groupId:'finance',quorum:1,escalateAfterMs:60000,escalationGroupId:null}]}];
  p.taxCodes.push({code:'V13',mode:'recoverable',recovery:{...syntheticTaxRule(),recoverableBps:5000,headerBasis:{freight:'included',discount:'reduces_base',partialTax:'half_up_taxable_base_proportion'}}});
  const f=await businessFixture({input,policy:p,onboard:false});
  await f.onboard({...f.supplier,catalog:[{sku:'KALE-24',unit:'case',unitPriceCents:500},{sku:'LETTUCE-12',unit:'case',unitPriceCents:500}]});
  const a=acceptance(input,'1');
  const template=a.lines[0]!;
  a.lines=[0,1].map(i=>{
    const line=c.lines[i]!,agreement=input.purchasingEvidence[0]!.lines[i]!,receipt=input.purchasingEvidence[1]!.lines[i]!;
    const net=i?'$10.00':'$15.00',tax=i?'$1.05':'$1.65';
    const claim:TaxClaim={calculation:'rate',rateBps:1000,jurisdiction:'SYNTHETIC-JURISDICTION',taxPointDate:'2026-10-19',priceBasis:'exclusive',taxableBaseCents:i?1050:1650,originalTaxCents:i?105:165,originalGrossCents:i?1155:1815,recoverableCents:26,derivedHeaderBasis:{freight:'included',discount:'reduces_base'},facts:{net:{...cite(doc,net),unit:'major'},tax:{...cite(doc,tax),unit:'major'},date:cite(doc,'2026-10-19'),priceBasis:cite(doc,'tax exclusive'),jurisdiction:cite(doc,'SYNTHETIC-JURISDICTION'),rate:cite(doc,'10%')},eligibilityEvidence:[cite(eligibility,eligibility.extractedText)],eligibilityRationale:'Independent synthetic eligibility, requires separate tax reviewer'};
    return {...structuredClone(template),lineId:line.lineId,quantity:'1',netCents:500,taxCents:51,taxCode:'V13',agreement:{source:input.purchasingEvidence[0]!.source,lineId:agreement.lineId},receipts:[{source:input.purchasingEvidence[1]!.source,lineId:receipt.lineId,quantity:'1'}],allocations:[{...template.allocations[0]!,amountCents:525},{...template.allocations[0]!,account:'1180',treatment:'tax' as const,amountCents:26}],tax:claim,headerAllocation:{originalFreightCents:i?100:200,originalDiscountCents:50,acceptedFreightCents:i?30:20,acceptedDiscountCents:i?20:10}};
  });
  a.freightCents=50;a.discountCents=30;a.freightAllocations=[{...template.allocations[0]!,amountCents:50}];a.discountAllocations=[{...template.allocations[0]!,amountCents:30}];a.taxHeaderEvidence={freight:{...cite(doc,'$3.00'),unit:'major'},discount:{...cite(doc,'$1.00'),unit:'major'}};
  async function approve(prop:{proposalId:string;proposalHash:string;route:any[]}){let result:any;for(const step of prop.route)result=await f.vote(prop,step.groupId==='tax-review'?'second':step.groupId);return result;}
  async function credit(originalApprovalId:string,index:number,key:string,freight=index?30:20,discount=index?20:10,tax=51){
    const next=packet(key),nc=next.candidate!,nl=nc.lines[0]!,original=c.lines[index]!;
    nc.kind='credit_note';next.documents[0]!.kind='credit_note';nl.sku=original.sku;nl.description=original.description;nl.quantity.decimal='1';nl.unitPriceCents=500;nl.amountCents=500;nl.taxCents=tax;nl.allocations[0]!.amountCents=500+tax;
    nc.subtotalCents=500;nc.taxCents=tax;nc.freightCents=freight;nc.discountCents=discount;nc.totalCents=500+tax+freight-discount;nc.freightAllocations=freight?[{...nl.allocations[0]!,amountCents:freight}]:[];nc.discountAllocations=discount?[{...nl.allocations[0]!,amountCents:discount}]:[];
    setText(next.documents[2]!,`Independent return ${key} ${nl.sku} 1 case accepted 2026-10-19`);next.purchasingEvidence[1]!.source=binding(next.documents[2]!);Object.assign(next.purchasingEvidence[1]!.lines[0]!,{sku:nl.sku,quantity:{decimal:'1',unit:'case'},unitPriceCents:500});syncPrimary(next);
    const detail=await f.reviewed(next),plan:CreditPlan={originalCaseId:f.detail.caseId,originalApprovalId,freightCents:freight,discountCents:discount,lines:[{creditLineId:'line-1',originalLineId:original.lineId,basis:'quantity_return',quantity:'1',netCents:500,taxCents:tax,returnEvidence:[binding(next.documents[2]!)],headerAllocation:{freightCents:freight,discountCents:discount}}],reason:'Independent original per-line header capacity'};
    const propose=()=>f.t.mutation(br.propose!,{...f.ap,input:{caseId:detail.caseId,expectedRevision:detail.revision,snapshotHash:detail.snapshotHash,idempotencyKey:key,policyVersion:p.version,supplierRevision:1,credit:plan}});
    return {plan,detail,propose};
  }
  const state=()=>f.t.run(async ctx=>({journals:await ctx.db.query('journalEntries').collect(),credits:await ctx.db.query('apCreditLinks').collect(),bills:await ctx.db.query('demoBills').collect(),commands:await ctx.db.query('demoCommands').collect()}));
  return {...f,a,approve,credit,state};
}
export function partial(a:BusinessAcceptance){
  const x=structuredClone(a),l=x.lines[0]!;l.quantity='1';l.netCents=3850;l.taxCents=385;l.receipts[0]!.quantity='1';l.tax!.recoverableCents=142;
  l.allocations[0]!.amountCents=4093;l.allocations[1]!.amountCents=142;
  return x;
}
