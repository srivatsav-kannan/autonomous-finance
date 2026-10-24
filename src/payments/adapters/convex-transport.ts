import type { ConvexHttpClient } from "convex/browser";

export type KernelTransport = Pick<ConvexHttpClient, "query" | "mutation">;
