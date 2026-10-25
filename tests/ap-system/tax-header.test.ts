import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreditPlan } from "../../src/ap-system/domain-contracts";
import type { TaxClaim } from "../../src/ap-system/tax-contracts";
import { taxClaimSchema } from "../../src/ap-system/tax-contracts";
import { acceptedHeaderTax, creditHeaderProblems, expectedHeaderCreditTax } from "../../src/ap-system/tax-header";
import { packet } from "./accounting-fixture";
import { acceptance, binding, br, businessFixture, policy, subject, syncPrimary } from "./business-fixture";
import { cite, setText, syntheticTaxRule, taxEvidenceFixture } from "./tax-fixture";
afterEach(() => vi.unstubAllEnvs());

async function headerFixture(partial = false, optIn = true) {
  const input = packet("HEADER-TAX"); const c=input.candidate!;
  c.freightCents=1000;c.discountCents=200;c.taxCents=850;c.totalCents=9350;
  c.lines[0]!.taxCents=850;c.lines[0]!.allocations[0]!.amountCents=8550;
  syncPrimary(input);
  const doc=input.documents[0]!, eligibility=taxEvidenceFixture().documents.at(-1)!;
  setText(doc,`${doc.extractedText}\nNet $77.00\nFreight $10.00\nDiscount $2.00\nTax $8.50\nRate 10%\nTax point 2026-10-19\nPricing tax exclusive\nJurisdiction SYNTHETIC-JURISDICTION`);
  c.evidence.forEach(e=>{e.source=binding(doc);});input.documents.push(eligibility);c.sources=input.documents.map(binding);
  const p=policy();p.groups.push({groupId:"tax-review",members:[subject("second")]});p.accounts.push({account:"1180",treatment:"tax"});
  p.taxCodes.push({code:"TEST",mode:"recoverable",recovery:{...syntheticTaxRule(),headerBasis:{freight:"included",discount:"reduces_base",partialTax:"half_up_taxable_base_proportion"}}});
  if (!optIn) delete p.taxCodes.find(t=>t.code==="TEST")!.recovery!.headerBasis;
  const f=await businessFixture({input,policy:p}),a=acceptance(input,partial?"1":"2"),l=a.lines[0]!;
  l.taxCode="TEST";a.freightCents=partial?100:1000;a.discountCents=partial?50:200;
  l.taxCents=partial?390:850;
  const template=l.allocations[0]!;
  l.allocations=[{...template,amountCents:l.netCents},{...template,account:"1180",treatment:"tax",amountCents:l.taxCents}];
  a.freightAllocations=[{...template,amountCents:a.freightCents}];a.discountAllocations=[{...template,amountCents:a.discountCents}];
  l.headerAllocation={originalFreightCents:1000,originalDiscountCents:200,acceptedFreightCents:a.freightCents,acceptedDiscountCents:a.discountCents};
  a.taxHeaderEvidence={freight:{...cite(doc,"$10.00"),unit:"major"},discount:{...cite(doc,"$2.00"),unit:"major"}};
  const claim:TaxClaim={calculation:"rate",jurisdiction:"SYNTHETIC-JURISDICTION",taxPointDate:"2026-10-19",priceBasis:"exclusive",rateBps:1000,taxableBaseCents:8500,originalTaxCents:850,originalGrossCents:9350,recoverableCents:l.taxCents,
    derivedHeaderBasis:{freight:"included",discount:"reduces_base"},facts:{net:{...cite(doc,"$77.00"),unit:"major"},tax:{...cite(doc,"$8.50"),unit:"major"},date:cite(doc,"2026-10-19"),priceBasis:cite(doc,"tax exclusive"),jurisdiction:cite(doc,"SYNTHETIC-JURISDICTION"),rate:cite(doc,"10%")},eligibilityEvidence:[cite(eligibility,eligibility.extractedText)],eligibilityRationale:"Synthetic fixture only; no practitioner approval"};
  l.tax=claim;
  async function approve(prop:any){let r:any;for(const step of prop.route)r=await f.vote(prop,step.groupId==="tax-review"?"second":step.groupId==="owner"?"owner":"finance");return r;}
  async function credit(originalApprovalId:string,key:string,freight:number,discount:number,tax:number){
    const next=packet(key),nc=next.candidate!;nc.kind="credit_note";next.documents[0]!.kind="credit_note";
    const nl=nc.lines[0]!;nl.quantity.decimal="1";nl.amountCents=3850;nl.taxCents=tax;nl.allocations[0]!.amountCents=3850+tax;
    nc.subtotalCents=3850;nc.taxCents=tax;nc.freightCents=freight;nc.discountCents=discount;nc.totalCents=3850+tax+freight-discount;
    setText(next.documents[2]!,`Unique return ${key}: received KALE-24 1 case`);next.purchasingEvidence[1]!.source=binding(next.documents[2]!);next.purchasingEvidence[1]!.lines[0]!.quantity.decimal="1";syncPrimary(next);
    const detail=await f.reviewed(next);const plan:CreditPlan={originalCaseId:f.detail.caseId,originalApprovalId,freightCents:freight,discountCents:discount,lines:[{creditLineId:"line-1",originalLineId:"line-1",basis:"quantity_return",quantity:"1",netCents:3850,taxCents:tax,returnEvidence:[binding(next.documents[2]!)],headerAllocation:{freightCents:freight,discountCents:discount}}],reason:"Explicit credit header allocation"};
    const propose=()=>f.t.mutation(br.propose!,{...f.ap,input:{caseId:detail.caseId,expectedRevision:detail.revision,snapshotHash:detail.snapshotHash,idempotencyKey:key,policyVersion:p.version,supplierRevision:1,credit:plan}});
    return {plan,propose};
  }
  const state=()=>f.t.run(async ctx=>({journals:await ctx.db.query("journalEntries").collect(),credits:await ctx.db.query("apCreditLinks").collect(),commands:await ctx.db.query("demoCommands").collect()}));
  return {...f,a,approve,credit,state};
}

describe("explicit original and accepted header tax basis",()=>{
  it.each([false,true])("posts supported tax and header amounts (partial=%s)",async partial=>{
    const f=await headerFixture(partial);const p=await f.propose(f.detail,f.a);await f.approve(p);const s=await f.state();
    expect(s.journals).toHaveLength(1);expect(s.commands).toHaveLength(0);
    const net=(account:string)=>s.journals[0]!.lines.filter(l=>l.account===account).reduce((n,l)=>n+l.debit-l.credit,0);
    expect([net("5000"),net("1180"),net("2000")]).toEqual(partial?[3900,390,-4290]:[8500,850,-9350]);
    if(partial)expect(acceptedHeaderTax(f.a.lines[0]!,f.input.candidate!.lines[0]!)).toEqual({originalBase:8500,acceptedBase:3900,taxCents:390});
  });
  it.each(["missing_policy","missing_shares","wrong_total","stale_evidence","computed_as_printed","inflated_base"])("holds %s without posting",async kind=>{
    const f=await headerFixture(false,kind!=="missing_policy");const a=structuredClone(f.a);
    if(kind==="missing_shares")delete a.lines[0]!.headerAllocation;
    if(kind==="wrong_total")a.lines[0]!.headerAllocation!.originalFreightCents--;
    if(kind==="stale_evidence")a.taxHeaderEvidence!.freight!.source.revision++;
    if(kind==="computed_as_printed")a.lines[0]!.tax!.facts.base=a.lines[0]!.tax!.facts.net;
    if(kind==="inflated_base")a.lines[0]!.tax!.taxableBaseCents++;
    await expect(f.propose(f.detail,a)).rejects.toThrow();expect((await f.state()).journals).toHaveLength(0);
  });
  it("reverses distinct header shares cumulatively instead of quantity-only tax",async()=>{
    const f=await headerFixture();const p=await f.propose(f.detail,f.a);await f.approve(p);
    const one=await f.credit(p.proposalId,"HEADER-RETURN-1",100,50,390);await f.approve(await one.propose());
    const two=await f.credit(p.proposalId,"HEADER-RETURN-2",900,150,460);await f.approve(await two.propose());
    const s=await f.state();expect(s.credits).toHaveLength(2);
    for(const account of ["5000","1180","2000"])expect(s.journals.flatMap(j=>j.lines).filter(l=>l.account===account).reduce((n,l)=>n+l.debit-l.credit,0)).toBe(0);
  });
  it("holds a quantity-only tax reduction and cumulative header overuse",async()=>{
    const f=await headerFixture();const p=await f.propose(f.detail,f.a);await f.approve(p);
    const bad=await f.credit(p.proposalId,"BAD-TAX",100,50,425);await expect(bad.propose()).rejects.toThrow(/credit_tax_treatment/);
    const first=await f.credit(p.proposalId,"FIRST",100,50,390);await f.approve(await first.propose());
    const second=await f.credit(p.proposalId,"OVERUSE",901,150,460);await expect(second.propose()).rejects.toThrow(/tax_header_credit_capacity/);
    expect((await f.state()).credits).toHaveLength(1);
  });
  it("requires explicit zero header shares on historical retries and separates derived facts",async()=>{
    const f=await headerFixture();const p:CreditPlan={originalCaseId:"c",originalApprovalId:"a",freightCents:0,discountCents:0,lines:[{creditLineId:"1",originalLineId:"line-1",basis:"tax_adjustment",quantity:"0",netCents:0,taxCents:1,returnEvidence:[]}],reason:"test"};
    expect(creditHeaderProblems(p,f.a,[])).toContain("tax_header_credit");
    expect(taxClaimSchema.safeParse(f.a.lines[0]!.tax).success).toBe(true);
    expect(expectedHeaderCreditTax(f.a.lines[0]!,{...p.lines[0]!,basis:"price_adjustment",netCents:3850,headerAllocation:{freightCents:100,discountCents:50}},[])).toBe(390);
  });
});

it("keeps explicit excluded header treatment out of the base and prevents negative bases", async()=>{
  const f=await headerFixture();const l=structuredClone(f.a.lines[0]!);
  l.tax!.derivedHeaderBasis={freight:"excluded",discount:"excluded"};
  expect(acceptedHeaderTax(l,{amountCents:7700,taxCents:770})).toEqual({originalBase:7700,acceptedBase:7700,taxCents:770});
  l.tax!.derivedHeaderBasis={freight:"excluded",discount:"reduces_base"};l.headerAllocation!.originalDiscountCents=8000;
  expect(()=>acceptedHeaderTax(l,{amountCents:7700,taxCents:770})).toThrow(/tax_header_base/);
});
