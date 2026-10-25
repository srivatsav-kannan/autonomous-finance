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
import type * as asks from "../asks.js";
import type * as bank from "../bank.js";
import type * as demoEvidence from "../demoEvidence.js";
import type * as demoEvidenceSchema from "../demoEvidenceSchema.js";
import type * as demoOps from "../demoOps.js";
import type * as demoPayments from "../demoPayments.js";
import type * as demoSchema from "../demoSchema.js";
import type * as ledger from "../ledger.js";
import type * as lib_demoAuth from "../lib/demoAuth.js";
import type * as lib_demoEffects from "../lib/demoEffects.js";
import type * as lib_demoPost from "../lib/demoPost.js";
import type * as lib_invoiceIdentity from "../lib/invoiceIdentity.js";
import type * as lib_kernel from "../lib/kernel.js";
import type * as lib_payments_apply_command from "../lib/payments/applyCommand.js";
import type * as lib_payments_apply_effect from "../lib/payments/applyEffect.js";
import type * as lib_payments_apply_observation from "../lib/payments/applyObservation.js";
import type * as lib_payments_execution_config from "../lib/payments/executionConfig.js";
import type * as lib_payments_reservations from "../lib/payments/reservations.js";
import type * as lib_post from "../lib/post.js";
import type * as lib_routing from "../lib/routing.js";
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
  asks: typeof asks;
  bank: typeof bank;
  demoEvidence: typeof demoEvidence;
  demoEvidenceSchema: typeof demoEvidenceSchema;
  demoOps: typeof demoOps;
  demoPayments: typeof demoPayments;
  demoSchema: typeof demoSchema;
  ledger: typeof ledger;
  "lib/demoAuth": typeof lib_demoAuth;
  "lib/demoEffects": typeof lib_demoEffects;
  "lib/demoPost": typeof lib_demoPost;
  "lib/invoiceIdentity": typeof lib_invoiceIdentity;
  "lib/kernel": typeof lib_kernel;
  "lib/payments/applyCommand": typeof lib_payments_apply_command;
  "lib/payments/applyEffect": typeof lib_payments_apply_effect;
  "lib/payments/applyObservation": typeof lib_payments_apply_observation;
  "lib/payments/executionConfig": typeof lib_payments_execution_config;
  "lib/payments/reservations": typeof lib_payments_reservations;
  "lib/post": typeof lib_post;
  "lib/routing": typeof lib_routing;
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
