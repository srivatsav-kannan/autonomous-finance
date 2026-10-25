import type {CostState} from "../src/ap-system/cost-contracts";
/** Matches the period fixture's two-hour, $20 accrual with no store or discount. */
export function costUIFixture(originalEntryId="synthetic-accrual-journal"):CostState{
 return {originalEntryId,billId:null,accrualId:"synthetic-accrual",snapshotHash:"7".repeat(64),latestDate:"2026-10-20",supplierId:"synthetic-supplier",originalShares:[{originalLineId:"accrual",allocationIndex:0,account:"6000",store:null,treatment:"expense",period:"2026-10",side:"credit",amountCents:2000,remainingCents:2000}],positions:[{account:"6000",store:null,balanceCents:1000},{account:"1200",store:null,balanceCents:1000}],corrections:[{actionId:"synthetic-cost-action",entryId:"synthetic-cost-journal",date:"2026-10-20",fromAccount:"6000",toAccount:"1200",store:null,amountCents:1000}]};
}
/** Separate component-only signed bill example; never substituted for the period accrual. */
export function signedCostUIFixture():CostState{
 const state=costUIFixture("synthetic-signed-bill-journal");state.billId="synthetic-signed-bill";state.accrualId=null;
 state.originalShares.push({...state.originalShares[0]!,originalLineId:"discount",side:"debit",amountCents:100,remainingCents:100});
 state.originalShares.forEach(s=>s.store="synthetic-store");state.positions.forEach(p=>p.store="synthetic-store");state.positions[0]!.balanceCents=900;state.corrections.forEach(c=>c.store="synthetic-store");return state;
}
