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
import type * as ledger from "../ledger.js";
import type * as lib_kernel from "../lib/kernel.js";
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
  ledger: typeof ledger;
  "lib/kernel": typeof lib_kernel;
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
