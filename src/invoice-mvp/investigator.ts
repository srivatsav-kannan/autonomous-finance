import { createHash } from "node:crypto";
import { z } from "zod";
import type { CaseDetail, Conclusion, EvidenceRef, RuntimeMode, ToolCallInput } from "./contracts";
import { InvoiceError, type InvoiceBackend } from "./backend";
import { parseSupportedSource } from "./parser";
import { INVESTIGATOR_POLICY, ZERO_USAGE, type InvestigatorModel, type ModelRequest, type ModelUsage, type Observation, type ToolAction } from "./model";

export const idempotency = (scope: string, value: unknown) => `${scope}:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
const refFor = (d: CaseDetail): EvidenceRef => ({ documentId: d.source.documentId, version: d.source.version, contentHash: d.source.contentHash });
const evidenceSchema = z.object({ documentId: z.string().min(1), version: z.number().int().positive(), contentHash: z.string().min(1), quote: z.string().optional() }).strict();
const conclusionSchema = z.object({
  treatment: z.enum(["include_invoice", "include_credit", "exclude", "needs_evidence"]),
  customerId: z.string().min(1).optional(), customerName: z.string().min(1).optional(), documentNumber: z.string().min(1).optional(),
  amountCents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(), reason: z.string().min(1).max(2000),
  evidence: z.array(evidenceSchema).min(1).max(20), contradictions: z.array(z.string().max(1000)).max(20), missingEvidence: z.array(z.string().max(1000)).max(20), question: z.string().max(2000).optional(),
  category: z.string().max(100).optional(), supersedesDocumentId: z.string().min(1).optional(),
}).strict();

export interface InvestigationResult { caseId: string; mode: RuntimeMode; outcome: string; toolCalls: number; modelCalls: number; usage: ModelUsage }

/** Bounded single investigator. Tool results contain facts, never a chain-of-thought transcript. */
export async function investigate(backend: InvoiceBackend, initial: CaseDetail, model?: InvestigatorModel, maxTurns = 10): Promise<InvestigationResult> {
  const mode = model?.mode ?? "deterministic";
  const c = initial.case;
  const evidence = [refFor(initial)];
  let toolCalls = 0, modelCalls = 0;
  const usage = { ...ZERO_USAGE };
  const observations: Observation[] = [];
  const observedSources = new Map<string, CaseDetail>([[c.documentId, initial]]);
  const inspectedSources = new Set<string>();
  const checkedTools = new Set<string>();
  let conclusion: Conclusion | undefined;
  const audit = async (tool: string, summary: string, stats: Partial<ModelUsage> = {}, unique: unknown = toolCalls) => {
    const call: ToolCallInput = { tool, summary, mode, ...(model ? { model: model.model } : {}), evidence, ...stats };
    await backend.recordToolCall(c.caseId, c.evidenceVersion, call, idempotency("tool", [c.caseId, c.evidenceVersion, mode, unique, call]));
  };
  const snapshot = await backend.workspace();
  const parsed = parseSupportedSource(initial.source, refFor(initial));
  const related = async (customerId?: string, documentNumber?: string) => {
    const candidates = snapshot.cases.filter((s) => s.caseId !== c.caseId && !["superseded", "duplicate"].includes(s.status) && (!customerId || !s.customerId || s.customerId === customerId));
    const results = [];
    for (const s of candidates.slice(0, 100)) {
      const d = await backend.caseDetail(s.caseId);
      const p = parseSupportedSource(d.source, refFor(d));
      const candidate = d.acceptedProposal?.conclusion ?? d.currentProposal?.conclusion ?? p.conclusion;
      if (customerId && candidate.customerId !== customerId || documentNumber && candidate.documentNumber !== documentNumber) continue;
      observedSources.set(d.source.documentId, d);
      results.push({ caseId: s.caseId, status: s.status, source: { name: d.source.name, ...refFor(d) }, conclusion: candidate });
    }
    return { documents: results, truncated: candidates.length > 100 };
  };
  const execute = async (action: ToolAction): Promise<unknown> => {
    const input = action.input;
    switch (action.name) {
      case "inspect_source": {
        const args = z.object({ documentId: z.string().optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(80_000).optional() }).strict().parse(input);
        const d = observedSources.get(args.documentId ?? c.documentId);
        if (!d) throw new InvoiceError("unobserved_source", "Retrieve related documents before inspecting their source.");
        inspectedSources.add(d.source.documentId);
        const offset = args.offset ?? 0, end = Math.min(d.source.text.length, offset + (args.limit ?? 20_000));
        return { ...refFor(d), name: d.source.name, mimeType: d.source.mimeType, text: d.source.text.slice(offset, end), offset, nextOffset: end < d.source.text.length ? end : null, totalCharacters: d.source.text.length, originalBytesPreserved: d.source.contentBase64 !== undefined, status: d.case.status };
      }
      case "related_documents": {
        const args = z.object({ customerId: z.string().optional(), documentNumber: z.string().optional() }).strict().parse(input);
        return related(args.customerId, args.documentNumber);
      }
      case "related_customers": {
        const args = z.object({ query: z.string().optional() }).strict().parse(input);
        const q = args.query?.toLowerCase();
        return snapshot.customerTotals.filter((v) => !q || [v.customerId, v.legalName, ...v.aliases].some((s) => s.toLowerCase().includes(q))).map((v) => ({ customerId: v.customerId, legalName: v.legalName, aliases: v.aliases })).slice(0, 100);
      }
      case "policy": z.object({}).strict().parse(input); return INVESTIGATOR_POLICY;
      case "propose_disposition": {
        if (!inspectedSources.has(c.documentId) || !checkedTools.has("policy") || !checkedTools.has("related_documents") || !checkedTools.has("related_customers")) throw new InvoiceError("investigation_incomplete", "Inspect this source and retrieve related documents, customers and policy before proposing.");
        const proposal = conclusionSchema.parse(input);
        for (const ref of proposal.evidence) {
          const source = observedSources.get(ref.documentId)?.source;
          if (!source || !inspectedSources.has(ref.documentId) || source.version !== ref.version || source.contentHash !== ref.contentHash || ref.quote && !source.text.includes(ref.quote)) throw new InvoiceError("invalid_evidence", "Every proposal reference must match exact inspected source evidence.");
        }
        if (!proposal.evidence.some((r) => r.documentId === c.documentId)) throw new InvoiceError("missing_own_source", "A conclusion must cite the case's original source.");
        if (proposal.treatment.startsWith("include_") && (!proposal.customerId || !proposal.documentNumber || !proposal.amountCents)) throw new InvoiceError("invalid_conclusion", "Include proposals require explicit customer, document number and amount.");
        // Deterministic findings cannot be erased by a model's unsupported confidence.
        proposal.contradictions = [...new Set([...parsed.conclusion.contradictions, ...proposal.contradictions])];
        if (proposal.contradictions.length && !proposal.question) proposal.question = `Should this exact proposed treatment be accepted despite: ${proposal.contradictions.join("; ")}?`;
        conclusion = proposal;
        return { outcome: "proposal_ready_for_human_review" };
      }
      case "ask_human": {
        const args = z.object({ question: z.string().min(10).max(2000), missingEvidence: z.array(z.string().min(1)).min(1).max(20), contradictions: z.array(z.string()).max(20).optional() }).strict().parse(input);
        conclusion = { treatment: "needs_evidence", reason: "Investigator could not establish a supported accounting treatment.", evidence, question: args.question, missingEvidence: args.missingEvidence, contradictions: [...parsed.conclusion.contradictions, ...args.contradictions ?? []] };
        return { outcome: "human_evidence_required" };
      }
      default: throw new InvoiceError("unknown_tool", "Only the bounded invoice investigation tools are available.");
    }
  };
  const runTool = async (action: ToolAction) => {
    toolCalls++;
    try {
      const result = await execute(action);
      checkedTools.add(action.name);
      observations.push({ tool: action.name, input: action.input, result });
      await audit(action.name, `${action.name}: completed${action.name === "ask_human" ? ` — ${conclusion?.question}` : ""}`);
    } catch (e) {
      if (e instanceof InvoiceError && /stale|conflict|forbidden|unauthorized/.test(e.code)) throw e;
      const message = e instanceof Error ? e.message : "Tool failed";
      observations.push({ tool: action.name, input: action.input, result: { error: message }, error: true });
      await audit(action.name, `${action.name}: rejected — ${message.slice(0, 500)}`);
    }
  };

  if (!model) {
    for (const action of [
      { name: "inspect_source", input: {} }, { name: "related_documents", input: { customerId: parsed.conclusion.customerId, documentNumber: parsed.conclusion.documentNumber } },
      { name: "related_customers", input: {} }, { name: "policy", input: {} },
    ] as ToolAction[]) await runTool(action);
    conclusion = parsed.conclusion;
    const matches = (observations.find((o) => o.tool === "related_documents")?.result as Awaited<ReturnType<typeof related>> | undefined)?.documents ?? [];
    if (conclusion.treatment.startsWith("include_") && matches.length) {
      conclusion.contradictions.push("Another current source uses the same customer and document number; verify duplicate versus revision before recording.");
      conclusion.question = `Should ${conclusion.documentNumber} count independently of the existing source, or should this source be excluded as a duplicate? Supply an explicit replacement import if it revises an earlier invoice.`;
    }
    for (const customer of parsed.customers) await backend.registerCustomer({ customerId: customer.customerId, legalName: customer.customerName, aliases: customer.aliases, evidence, idempotencyKey: idempotency("customer", [customer, evidence]) });
    await audit(conclusion.treatment === "needs_evidence" ? "ask_human" : "propose_disposition", conclusion.question ?? conclusion.reason, {}, "deterministic-conclusion");
    toolCalls++;
  } else {
    for (let turn = 0; turn < Math.min(20, Math.max(1, maxTurns)); turn++) {
      const request: ModelRequest = { caseId: c.caseId, evidenceVersion: c.evidenceVersion, observations, decisionSummaries: initial.decisions.map((d) => `${d.action} on proposal ${d.proposalId}: ${d.note ?? "No note"}`) };
      const reservation = model.reservation(request);
      if (mode === "live_model") {
        if (!model.budget) throw new InvoiceError("invalid_budget", "Live requests require a resource cap.");
        // All reservations count even if the process crashed or the provider failed. No refunds.
        const reserved = { calls: 0, ...ZERO_USAGE };
        for (const summary of (await backend.workspace()).cases) {
          for (const entry of (await backend.caseDetail(summary.caseId)).audit) {
            if (entry.toolCall?.tool !== "model_reservation") continue;
            reserved.calls++; reserved.inputTokens += entry.toolCall.inputTokens ?? 0; reserved.outputTokens += entry.toolCall.outputTokens ?? 0; reserved.costMicros += entry.toolCall.costMicros ?? 0;
          }
        }
        const budget = model.budget;
        if (reserved.calls + 1 > budget.maxCalls || reserved.inputTokens + reservation.inputTokens > budget.maxInputTokens || reserved.outputTokens + reservation.outputTokens > budget.maxOutputTokens || reserved.costMicros + reservation.costMicros > budget.maxCostMicros) {
          conclusion = { treatment: "needs_evidence", reason: "Investigation stopped before a model request because its reserved resource cap was exhausted.", evidence, contradictions: parsed.conclusion.contradictions, missingEvidence: ["Further evidence or an explicitly authorized evaluation budget"], question: "Please supply the final invoice evidence or review this case manually; no further model request was made." };
          await audit("resource_limit", conclusion.reason, {}, `limit-${turn}`);
          break;
        }
        await audit("model_reservation", `Reserved one ${model.model} request; max output ${reservation.outputTokens}; no retries or fallback.`, reservation, `reservation-${c.currentProposalId ?? "initial"}-${turn}-${reserved.calls}`);
      }
      try {
        const result = await model.next(request);
        modelCalls++;
        for (const k of Object.keys(usage) as (keyof ModelUsage)[]) usage[k] += result.usage[k];
        await audit("model_usage", "Actual provider-reported usage for one completed investigator request.", result.usage, `usage-${turn}-${modelCalls}`);
        await runTool(result.action);
      } catch (e) {
        if (e instanceof InvoiceError && /stale|conflict|forbidden|unauthorized/.test(e.code)) throw e;
        await audit("model_failure", "Model request failed or produced an invalid tool action; case remains unresolved.", {}, `failure-${turn}`);
        break;
      }
      if (conclusion) break;
    }
    conclusion ??= { treatment: "needs_evidence", reason: "Bounded investigator stopped without a supported conclusion.", evidence, contradictions: parsed.conclusion.contradictions, missingEvidence: ["A supported final invoice or credit memo and a resolved accounting treatment"], question: `Please provide the final issued billing document for “${initial.source.name}”, or exclude this source if it is only supporting evidence.` };
  }
  const result = await backend.submitProposal({ caseId: c.caseId, evidenceVersion: c.evidenceVersion, conclusion, mode, ...(model ? { model: model.model } : {}), idempotencyKey: idempotency("proposal", [c.caseId, c.evidenceVersion, mode, conclusion]) });
  return { caseId: c.caseId, mode, outcome: result.case.status, toolCalls, modelCalls, usage };
}
