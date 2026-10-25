import {creditFixture} from './quickbooks-business-fixture';
import {api} from '../demo-fixture';
import {PAYMENT_EXECUTOR_VERSION} from '../../src/payments/contracts';
import {openFakeBank} from '../../src/integrations/banking/fake';
import {ExecutePaymentEffect} from '../../src/payments/application/execute-payment-effect';
import {ReconcilePaymentEvidence} from '../../src/payments/application/reconcile-payment-evidence';
import {createConvexPaymentKernel} from '../../src/payments/adapters/convex-payment-kernel';
import {createConvexPaymentEvidence} from '../../src/payments/adapters/convex-payment-evidence';
import type {KernelTransport} from '../../src/payments/adapters/convex-transport';
import type {Id} from '../../convex/_generated/dataModel';
export const banks: ReturnType<typeof openFakeBank>[] = [];
export async function settlementFixture(queue = true, department: string | null = 'ops') {
  const f = await creditFixture(0, {department, scope: 'cost_and_settlement'}), credit = await f.credit();
  const args = {scope: f.scope, seatId: 'payments', token: 'token-payments', requestKey: 'v11-partial-payment', billIds: [f.original.billId as Id<'demoBills'>], billAmounts: [{billId: f.original.billId as Id<'demoBills'>, amountCents: 3000}], credits: [{creditId: credit.creditId, amountCents: 1000}]};
  const request = await f.t.mutation(api.demoPayments.requestPayment, args);
  const authorize = () => f.humans.finance!.mutation(api.demoPayments.approveAndQueue, {scope: f.scope, ...request});
  const approved = queue ? await authorize() : null;
  const bank = openFakeBank({path: ':memory:', scope: f.scope, seed: 'v11-independent', startTime: new Date(Date.now()).toISOString()}); banks.push(bank);
  const kernel = createConvexPaymentKernel(f.t as unknown as KernelTransport, f.scope, 'test-dispatch');
  const evidence = createConvexPaymentEvidence(f.t as unknown as KernelTransport, f.scope, 'test-evidence');
  let seq = 0;
  const dispatch = new ExecutePaymentEffect(kernel, bank.provider, 'v11-worker', {now: Date.now, newLeaseToken: () => `v11-independent-${++seq}`, startHeartbeat: () => () => {}});
  const reconcile = new ReconcilePaymentEvidence(evidence, bank.provider, f.scope, Date.now);
  const claim = () => f.t.mutation(api.demoPayments.claim, {scope: f.scope, token: 'test-dispatch', paymentExecutorVersion: PAYMENT_EXECUTOR_VERSION, workerId: 'v11-direct-worker', leaseToken: `v11-direct-${++seq}`});
  const state = () => f.t.run(async ctx => ({versions: await ctx.db.query('demoVersions').collect(), commands: await ctx.db.query('demoCommands').collect(), journals: await ctx.db.query('journalEntries').collect(), bills: await ctx.db.query('demoBills').collect(), credits: await ctx.db.query('demoCredits').collect(), attempts: await ctx.db.query('demoAttempts').collect(), applications: await ctx.db.query('apCreditApplications').collect()}));
  return {...f, credit, args, request, authorize, approved, bank, dispatch, reconcile, claim, state};
}
