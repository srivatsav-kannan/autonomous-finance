import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {acceptance,binding,br,syncPrimary} from './business-fixture';
import {packet} from './accounting-fixture';
import {physicalFixture,physicalPacket,physical,originalLines,setOriginal} from './v9-physical-fixture';
import type {PhysicalLine} from '../../src/ap-system/physical-line-contracts';
const epoch=Date.parse('2026-10-31T20:00:00Z');beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(epoch);});afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
const returnLines=originalLines.map(l=>'Supplier return '+l),returnPhysical:PhysicalLine[]=physical.map((l,i)=>({...l,locator:{page:1,start:i?returnLines[0]!.length+1:0,end:(i?returnLines[0]!.length+1:0)+returnLines[i]!.length,quote:returnLines[i]!}}));
function creditPacket(number:string,quantity:'0.5'|'1.5',style:'split'|'merged'='split'){
 const input=physicalPacket(number,style),c=input.candidate!,line=c.lines[0]!,cents=quantity==='0.5'?1925:5775;c.kind='credit_note';input.documents[0]!.kind='credit_note';line.quantity.decimal=quantity;line.amountCents=cents;line.allocations[0]!.amountCents=cents;c.subtotalCents=cents;c.totalCents=cents;setOriginal(input.documents[2]!,returnLines.join('\n'));input.purchasingEvidence[1]!.source=binding(input.documents[2]!);return syncPrimary(input);
}
it('prevents one physical half-unit from being reused while aggregate receipt and agreement still have spare capacity',async()=>{
 const f=await physicalFixture(),m=await f.mapping(),cat=await f.approveMapping(m);await f.recognize(f.detail,f.accepted(f.input,m.reviewId,['north']));
 const other=physicalPacket('V9-spare-aggregate','merged'),d=await f.reviewed(other),map=await f.mapping(other,d,cat.catalogId);await f.approveMapping(map);await expect(f.propose(d,f.accepted(other,map.reviewId,['north']))).rejects.toThrow(/Physical receipt line capacity/);expect((await f.snapshot()).bills).toHaveLength(1);
 await f.recognize(d,f.accepted(other,map.reviewId,['south']));expect((await f.snapshot()).bills.reduce((n,b)=>n+b.approvedCents!,0)).toBe(7700);
});
it('uses distinct return physical pools across merged notes, prevents duplicate returns, and never replenishes receiving capacity',async()=>{
 const f=await physicalFixture(),m=await f.mapping(),originalCatalog=await f.approveMapping(m),original=await f.recognize(f.detail,f.accepted(f.input,m.reviewId));
 async function plan(input:ReturnType<typeof creditPacket>,d:typeof f.detail,reviewId:string,id:'north'|'south',key:string){const row=input.purchasingEvidence[1]!.lines.find(l=>l.lineId.endsWith('-'+id)||l.lineId.endsWith('merged'))!,quantity=id==='north'?'0.5':'1.5';return f.t.mutation(br.propose!,{...f.ap,input:{caseId:d.caseId,expectedRevision:d.revision,snapshotHash:d.snapshotHash,idempotencyKey:key,policyVersion:f.policy.version,supplierRevision:1,credit:{originalCaseId:f.detail.caseId,originalApprovalId:original.proposal.proposalId,freightCents:0,discountCents:0,reason:'Exact separately retained supplier return',lines:[{creditLineId:'line-1',originalLineId:'line-1',basis:'quantity_return',quantity,netCents:id==='north'?1925:5775,taxCents:0,returnEvidence:[input.purchasingEvidence[1]!.source],returnClaims:[{source:input.purchasingEvidence[1]!.source,lineId:row.lineId,quantity,identity:{reviewId,allocations:[{physicalLineId:id,quantity}]}}]}]}}});}
 const first=creditPacket('V9-return-north','0.5'),fd=await f.reviewed(first),fm=await f.mapping(first,fd,undefined,{physicalLines:returnPhysical}),returnCatalog=await f.approveMapping(fm);await f.vote(await plan(first,fd,fm.reviewId,'north','v9-credit-north'));
 const duplicate=creditPacket('V9-return-duplicate','0.5','merged'),dd=await f.reviewed(duplicate),dm=await f.mapping(duplicate,dd,returnCatalog.catalogId);await f.approveMapping(dm);const before=await f.snapshot();await expect(plan(duplicate,dd,dm.reviewId,'north','v9-credit-duplicate')).rejects.toThrow(/received_units_already_used/);expect(await f.snapshot()).toEqual(before);
 const second=creditPacket('V9-return-south','1.5','merged'),sd=await f.reviewed(second),sm=await f.mapping(second,sd,returnCatalog.catalogId);await f.approveMapping(sm);const sp=await plan(second,sd,sm.reviewId,'south','v9-credit-south');await f.vote(sp);await f.vote(sp,'finance');
 const state=await f.snapshot();expect(state.credits.map(c=>c.amountCents).sort((a,b)=>a-b)).toEqual([1925,5775]);expect(state.journals).toHaveLength(3);
 const extra=physicalPacket('V9-no-refilled-receipt'),ed=await f.reviewed(extra),em=await f.mapping(extra,ed,originalCatalog.catalogId);await f.approveMapping(em);await expect(f.propose(ed,f.accepted(extra,em.reviewId,['north']))).rejects.toThrow(/received_units_already_used/);
});
it('cannot relabel an existing receiving original as return capacity by reusing its catalog',async()=>{
 const f=await physicalFixture(),m=await f.mapping(),cat=await f.approveMapping(m),input=creditPacket('V9-purpose','0.5');setOriginal(input.documents[2]!,originalLines.join('\n'));input.purchasingEvidence[1]!.source=binding(input.documents[2]!);syncPrimary(input);const d=await f.reviewed(input);await expect(f.mapping(input,d,cat.catalogId)).rejects.toThrow(/physical_catalog_mismatch/);expect((await f.snapshot()).catalogs).toHaveLength(1);
});
it.each(['recognized','accrued'] as const)('holds untagged historical %s usage rather than guessing its physical allocation',async usage=>{
 const plain=packet('V9-legacy'),f=await physicalFixture(plain);
 if(usage==='recognized')await f.recognize(f.detail,acceptance(plain,'1'));
 else await f.approveClose({kind:'accrual',accrual:{supplierId:f.supplier.supplierId,source:plain.purchasingEvidence[1]!.source,lineId:plain.purchasingEvidence[1]!.lines[0]!.lineId,sku:'KALE-24',unit:'case',description:'Legacy untagged receipt accrual',quantity:'1',capacityQuantity:'2',unitPriceCents:3850,allocations:acceptance(plain,'1').lines[0]!.allocations,date:'2026-10-19',expectedInvoiceCaseId:null,quote:plain.documents[2]!.extractedText,reason:'Original historical accrual'}});
 const before=await f.snapshot();await expect(f.mapping()).rejects.toThrow(/physical_legacy_usage/);expect(await f.snapshot()).toEqual(before);
});
