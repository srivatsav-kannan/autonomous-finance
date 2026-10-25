import { createHash, randomBytes } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { env } from "./env";

export { api };

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newToken(): string {
  return randomBytes(24).toString("hex");
}

export function convex(options?: ConstructorParameters<typeof ConvexHttpClient>[1]): ConvexHttpClient {
  return new ConvexHttpClient(env("CONVEX_URL", process.env.VITE_CONVEX_URL), options);
}

/** A seat's authenticated handle on the kernel. Every call carries the seat's identity. */
export class SeatClient {
  readonly client: ConvexHttpClient;
  constructor(
    readonly runId: string,
    readonly seatId: string,
    private readonly token: string,
    client?: ConvexHttpClient,
  ) {
    this.client = client ?? convex();
  }

  get auth() {
    return { runId: this.runId, seatId: this.seatId, token: this.token };
  }
}

/** Admin handle for the world simulator and eval harness. */
export class AdminClient {
  readonly client: ConvexHttpClient;
  readonly secret: string;
  constructor(client?: ConvexHttpClient) {
    this.client = client ?? convex();
    this.secret = env("KERNEL_ADMIN_SECRET");
  }
}
