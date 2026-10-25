/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin from "../admin.js";
import type * as ap from "../ap.js";
import type * as apAccountingCorrections from "../apAccountingCorrections.js";
import type * as apAccountingExport from "../apAccountingExport.js";
import type * as apAccountingSchema from "../apAccountingSchema.js";
import type * as apBusiness from "../apBusiness.js";
import type * as apBusinessConfig from "../apBusinessConfig.js";
import type * as apBusinessExports from "../apBusinessExports.js";
import type * as apCaseAgent from "../apCaseAgent.js";
import type * as apCasePayments from "../apCasePayments.js";
import type * as apCases from "../apCases.js";
import type * as apClose from "../apClose.js";
import type * as apIdentity from "../apIdentity.js";
import type * as apOperationalMetrics from "../apOperationalMetrics.js";
import type * as apPaymentRunSchema from "../apPaymentRunSchema.js";
import type * as apPaymentRuns from "../apPaymentRuns.js";
import type * as apSandboxBootstrap from "../apSandboxBootstrap.js";
import type * as apSupplierContacts from "../apSupplierContacts.js";
import type * as apSystemSchema from "../apSystemSchema.js";
import type * as asks from "../asks.js";
import type * as bank from "../bank.js";
import type * as demoEvidence from "../demoEvidence.js";
import type * as demoEvidenceSchema from "../demoEvidenceSchema.js";
import type * as demoOps from "../demoOps.js";
import type * as demoPayments from "../demoPayments.js";
import type * as demoSchema from "../demoSchema.js";
import type * as invoiceCases from "../invoiceCases.js";
import type * as ledger from "../ledger.js";
import type * as lib_apSystem_accountingBankEvidence from "../lib/apSystem/accountingBankEvidence.js";
import type * as lib_apSystem_accountingCorrectionAuthority from "../lib/apSystem/accountingCorrectionAuthority.js";
import type * as lib_apSystem_accountingCredits from "../lib/apSystem/accountingCredits.js";
import type * as lib_apSystem_accruals from "../lib/apSystem/accruals.js";
import type * as lib_apSystem_agentWork from "../lib/apSystem/agentWork.js";
import type * as lib_apSystem_businessAuthority from "../lib/apSystem/businessAuthority.js";
import type * as lib_apSystem_businessExport from "../lib/apSystem/businessExport.js";
import type * as lib_apSystem_businessInvalidation from "../lib/apSystem/businessInvalidation.js";
import type * as lib_apSystem_businessLedger from "../lib/apSystem/businessLedger.js";
import type * as lib_apSystem_businessProjection from "../lib/apSystem/businessProjection.js";
import type * as lib_apSystem_casePayment from "../lib/apSystem/casePayment.js";
import type * as lib_apSystem_closeEvidence from "../lib/apSystem/closeEvidence.js";
import type * as lib_apSystem_closeExport from "../lib/apSystem/closeExport.js";
import type * as lib_apSystem_costState from "../lib/apSystem/costState.js";
import type * as lib_apSystem_governedCredits from "../lib/apSystem/governedCredits.js";
import type * as lib_apSystem_legacyGate from "../lib/apSystem/legacyGate.js";
import type * as lib_apSystem_periodView from "../lib/apSystem/periodView.js";
import type * as lib_apSystem_projection from "../lib/apSystem/projection.js";
import type * as lib_apSystem_shared from "../lib/apSystem/shared.js";
import type * as lib_apSystem_supplierContactEvidence from "../lib/apSystem/supplierContactEvidence.js";
import type * as lib_closeReadiness from "../lib/closeReadiness.js";
import type * as lib_demoAuth from "../lib/demoAuth.js";
import type * as lib_demoEffects from "../lib/demoEffects.js";
import type * as lib_demoPost from "../lib/demoPost.js";
import type * as lib_evidence from "../lib/evidence.js";
import type * as lib_invoiceIdentity from "../lib/invoiceIdentity.js";
import type * as lib_kernel from "../lib/kernel.js";
import type * as lib_payments_applyCommand from "../lib/payments/applyCommand.js";
import type * as lib_payments_applyEffect from "../lib/payments/applyEffect.js";
import type * as lib_payments_applyObservation from "../lib/payments/applyObservation.js";
import type * as lib_payments_executionConfig from "../lib/payments/executionConfig.js";
import type * as lib_payments_reservations from "../lib/payments/reservations.js";
import type * as lib_post from "../lib/post.js";
import type * as lib_routing from "../lib/routing.js";
import type * as lib_workerRequest from "../lib/workerRequest.js";
import type * as observe from "../observe.js";
import type * as payments from "../payments.js";
import type * as seats from "../seats.js";
import type * as tasks from "../tasks.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  ap: typeof ap;
  apAccountingCorrections: typeof apAccountingCorrections;
  apAccountingExport: typeof apAccountingExport;
  apAccountingSchema: typeof apAccountingSchema;
  apBusiness: typeof apBusiness;
  apBusinessConfig: typeof apBusinessConfig;
  apBusinessExports: typeof apBusinessExports;
  apCaseAgent: typeof apCaseAgent;
  apCasePayments: typeof apCasePayments;
  apCases: typeof apCases;
  apClose: typeof apClose;
  apIdentity: typeof apIdentity;
  apOperationalMetrics: typeof apOperationalMetrics;
  apPaymentRunSchema: typeof apPaymentRunSchema;
  apPaymentRuns: typeof apPaymentRuns;
  apSandboxBootstrap: typeof apSandboxBootstrap;
  apSupplierContacts: typeof apSupplierContacts;
  apSystemSchema: typeof apSystemSchema;
  asks: typeof asks;
  bank: typeof bank;
  demoEvidence: typeof demoEvidence;
  demoEvidenceSchema: typeof demoEvidenceSchema;
  demoOps: typeof demoOps;
  demoPayments: typeof demoPayments;
  demoSchema: typeof demoSchema;
  invoiceCases: typeof invoiceCases;
  ledger: typeof ledger;
  "lib/apSystem/accountingBankEvidence": typeof lib_apSystem_accountingBankEvidence;
  "lib/apSystem/accountingCorrectionAuthority": typeof lib_apSystem_accountingCorrectionAuthority;
  "lib/apSystem/accountingCredits": typeof lib_apSystem_accountingCredits;
  "lib/apSystem/accruals": typeof lib_apSystem_accruals;
  "lib/apSystem/agentWork": typeof lib_apSystem_agentWork;
  "lib/apSystem/businessAuthority": typeof lib_apSystem_businessAuthority;
  "lib/apSystem/businessExport": typeof lib_apSystem_businessExport;
  "lib/apSystem/businessInvalidation": typeof lib_apSystem_businessInvalidation;
  "lib/apSystem/businessLedger": typeof lib_apSystem_businessLedger;
  "lib/apSystem/businessProjection": typeof lib_apSystem_businessProjection;
  "lib/apSystem/casePayment": typeof lib_apSystem_casePayment;
  "lib/apSystem/closeEvidence": typeof lib_apSystem_closeEvidence;
  "lib/apSystem/closeExport": typeof lib_apSystem_closeExport;
  "lib/apSystem/costState": typeof lib_apSystem_costState;
  "lib/apSystem/governedCredits": typeof lib_apSystem_governedCredits;
  "lib/apSystem/legacyGate": typeof lib_apSystem_legacyGate;
  "lib/apSystem/periodView": typeof lib_apSystem_periodView;
  "lib/apSystem/projection": typeof lib_apSystem_projection;
  "lib/apSystem/shared": typeof lib_apSystem_shared;
  "lib/apSystem/supplierContactEvidence": typeof lib_apSystem_supplierContactEvidence;
  "lib/closeReadiness": typeof lib_closeReadiness;
  "lib/demoAuth": typeof lib_demoAuth;
  "lib/demoEffects": typeof lib_demoEffects;
  "lib/demoPost": typeof lib_demoPost;
  "lib/evidence": typeof lib_evidence;
  "lib/invoiceIdentity": typeof lib_invoiceIdentity;
  "lib/kernel": typeof lib_kernel;
  "lib/payments/applyCommand": typeof lib_payments_applyCommand;
  "lib/payments/applyEffect": typeof lib_payments_applyEffect;
  "lib/payments/applyObservation": typeof lib_payments_applyObservation;
  "lib/payments/executionConfig": typeof lib_payments_executionConfig;
  "lib/payments/reservations": typeof lib_payments_reservations;
  "lib/post": typeof lib_post;
  "lib/routing": typeof lib_routing;
  "lib/workerRequest": typeof lib_workerRequest;
  observe: typeof observe;
  payments: typeof payments;
  seats: typeof seats;
  tasks: typeof tasks;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
