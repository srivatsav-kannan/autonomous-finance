import { randomUUID } from "node:crypto";
import { makeFunctionReference } from "convex/server";
import type { KernelTransport } from "../payments/adapters/convex-transport";
import type { BankScope } from "../payments/contracts";
import {
  ControlPlane,
  ControlPlaneUnavailable,
  OperatorActionRequired,
  pause,
  WorkerStopped,
} from "./control-plane";
import {
  createAPCaseAgentTools,
  type APAgentCredential,
} from "./ap-case-tools";

export type APCaseStep = (context:{tools:ReturnType<typeof createAPCaseAgentTools>;lease:{caseId:string;generation:number};credential:APAgentCredential})=>Promise<Record<string,unknown>>;
/** Uses the existing worker RPC retry policy. Durable ownership/waits live exclusively in Convex. */
export class APCaseAgentWorker {
  private readonly control = new ControlPlane();
  constructor(
    private readonly client: KernelTransport,
    private readonly scope: BankScope,
    private readonly credentials: APAgentCredential[],
    private readonly step?: APCaseStep,
  ) {}
  async tick() {
    const outcomes = [];
    for (const credential of this.credentials) {
      const requestId = randomUUID();
      const lease = await this.control.call("apCaseAgent.claim", () =>
        this.client.mutation(
          makeFunctionReference<"mutation">("apCaseAgent:claim"),
          { scope: this.scope, ...credential, requestId },
        ),
      );
      if (!lease) continue;
      const tools = createAPCaseAgentTools(this.client, this.scope, credential);
      // Retrying this exact fenced mutation can recover a lost response without a new effect.
      try {
        const result = this.step ? await this.step({tools,lease:{caseId:lease.caseId,generation:lease.generation},credential}) : await this.control.call("apCaseAgent.advance", () =>
          tools.advance_case({
            caseId: lease.caseId,
            generation: lease.generation,
          }),
        );
        outcomes.push({ caseId: lease.caseId, ...result });
      } catch (error) {
        if (!(error instanceof OperatorActionRequired)) throw error;
        // The mutation rolled back on a definite domain rejection. If the lease was
        // superseded or paused, this only reports stale and cannot override its owner.
        const result = await this.control.call("apCaseAgent.failed", () =>
          this.client.mutation(
            makeFunctionReference<"mutation">("apCaseAgent:failed"),
            {
              scope: this.scope,
              ...credential,
              caseId: lease.caseId,
              generation: lease.generation,
            },
          ),
        );
        outcomes.push({
          caseId: lease.caseId,
          status: result.stale ? "superseded" : "escalated",
        });
      }
    }
    return outcomes;
  }
  async run(
    signal: AbortSignal,
    onProgress: (outcomes: unknown) => void = () => {},
  ) {
    while (!signal.aborted) {
      try {
        const outcomes = await this.tick();
        if (outcomes.length) onProgress(outcomes);
      } catch (e) {
        if (!(e instanceof ControlPlaneUnavailable)) throw e;
      }
      try {
        await pause(1_000, signal);
      } catch (e) {
        if (!(e instanceof WorkerStopped)) throw e;
      }
    }
  }
}
