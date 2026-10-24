// LLM judge for the Vals Finance Agent rubric. Kept separate from the agent: it
// sees only the question, one rubric check (operator + criteria) and the agent's
// submitted final answer. Operator semantics follow the Finance Agent Benchmark
// paper (arXiv 2508.00828): "correctness" is the paper's edgar_research_operator
// (criteria present as a complete, meaningful concept, rounded values accepted;
// format/style/length irrelevant); "contradiction" checks the answer against the
// full expert answer and fails if any part conflicts. A question is correct only
// if every check passes (conjunction rule). Vals v1.1 takes the mode of three
// judge samples; `samples` controls that here.
import Anthropic from "@anthropic-ai/sdk";
import { FALLBACK_BETA, JUDGE_EFFORT, JUDGE_MAX_TOKENS, MODEL } from "./config";
import type { RubricItem } from "./dataset";
import { getClient } from "./env";
import { addCost, costOfUsage, emptyCost, type CostBreakdown } from "./pricing";

export const JUDGE_SYSTEM = `You are an expert financial analyst grading answers for a benchmark of financial research questions about public companies and their SEC filings. You grade one check at a time.

You receive:
- QUESTION: the question the agent was asked.
- RESPONSE: the agent's final submitted answer.
- CHECK: one operator and its criteria, written by finance experts from their reference answer.

Grade only whether the RESPONSE satisfies the CHECK. The criteria are the ground truth for this check: do not use outside knowledge to decide what is true, and do not give credit for anything the RESPONSE does not actually say.

Operators:

correctness: PASS if the criteria is present in the RESPONSE as a complete, meaningful concept. This check verifies factual content such as numerical figures (accepting rounded values), names, dates, and relationships between facts. Every part of the criteria must be present: when the criteria ties a figure to a period, an entity, a direction or a comparison (for example "a 20.3% CAGR from 2019 to 2024" or "80bps beat from low end"), the RESPONSE must state that same relationship, not just the bare number. Different wording, structure, formatting, units or extra information do not matter; the format, writing style, and length of the RESPONSE do not affect this check.

contradiction: The criteria is the experts' full reference answer. PASS if no part of the RESPONSE conflicts with the reference answer. FAIL if the RESPONSE states something incompatible with the reference answer about the same item: a different value for the same figure (beyond rounding), a different date, name or entity, the opposite direction (increase vs. decrease, beat vs. miss), or a conclusion the reference answer rules out. Points the reference answer does not address, extra detail, and omissions are not contradictions.

Numbers and rounding:
- Two values match if they agree after rounding to the precision of the less precise one, or differ only because intermediate or final steps were rounded (for example criteria "79%" and response "78.72%"; criteria "18.78%" and response "18.8%"; criteria "$2.8 billion" and response "$2,834 million").
- Equivalent units and scales are the same value ($1.2 billion = $1,200 million; 80 bps = 0.80 percentage points; a "5% decrease" = "-5%"). Currency symbols may be present or absent.
- Values that differ by more than rounding are different values, even if they are close.

Write a short justification first, then the verdict.`;

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    justification: { type: "string" },
    verdict: { type: "string", enum: ["pass", "fail"] },
  },
  required: ["justification", "verdict"],
  additionalProperties: false,
} as const;

export interface JudgeSample {
  verdict: "pass" | "fail" | "error";
  justification: string;
  stop_reason: string | null;
  model: string;
  cost_usd: number;
}

export interface CheckJudgment {
  index: number;
  operator: string;
  criteria: string;
  samples: JudgeSample[];
  /** Mode of the samples (ties and errors resolve to fail). */
  verdict: "pass" | "fail";
  skipped?: string;
}

export interface QuestionJudgment {
  id: string;
  checks: CheckJudgment[];
  all_pass: boolean;
  passed: number;
  total: number;
  cost: CostBreakdown;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function userContent(question: string, answer: string, item: RubricItem): Anthropic.Beta.BetaContentBlockParam[] {
  return [
    {
      type: "text",
      text: `QUESTION:\n${question}\n\nRESPONSE:\n${answer}`,
      // Shared by every check of this question, so later checks read it from cache.
      cache_control: { type: "ephemeral" },
    },
    { type: "text", text: `CHECK:\noperator: ${item.operator}\ncriteria: ${item.criteria}` },
  ];
}

async function sampleOnce(question: string, answer: string, item: RubricItem): Promise<{ sample: JudgeSample; cost: CostBreakdown }> {
  const client = getClient();
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const msg = await client.beta.messages.create({
        model: MODEL,
        max_tokens: JUDGE_MAX_TOKENS,
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        thinking: { type: "adaptive" },
        output_config: { effort: JUDGE_EFFORT, format: { type: "json_schema", schema: VERDICT_SCHEMA } },
        system: JUDGE_SYSTEM,
        messages: [{ role: "user", content: userContent(question, answer, item) }],
      });
      const c = costOfUsage(msg.usage);
      const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      let verdict: JudgeSample["verdict"] = "error";
      let justification = text;
      try {
        const parsed = JSON.parse(text) as { verdict?: string; justification?: string };
        if (parsed.verdict === "pass" || parsed.verdict === "fail") verdict = parsed.verdict;
        justification = parsed.justification ?? "";
      } catch {
        // Unparseable (e.g. refusal or truncation): recorded as an error sample.
      }
      return {
        sample: { verdict, justification, stop_reason: msg.stop_reason, model: msg.model, cost_usd: c.total },
        cost: c.cost,
      };
    } catch (err) {
      lastErr = err;
      if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.AuthenticationError) throw err;
      await sleep(Math.min(60_000, 3000 * 2 ** attempt) * (0.5 + Math.random()));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function mode(samples: JudgeSample[]): "pass" | "fail" {
  const pass = samples.filter((s) => s.verdict === "pass").length;
  return pass * 2 > samples.length ? "pass" : "fail";
}

async function judgeCheck(question: string, answer: string, item: RubricItem, index: number, samples: number) {
  const results = [];
  let cost = emptyCost();
  for (let s = 0; s < samples; s++) {
    const r = await sampleOnce(question, answer, item);
    results.push(r.sample);
    cost = addCost(cost, r.cost);
  }
  const judgment: CheckJudgment = { index, operator: item.operator, criteria: item.criteria, samples: results, verdict: mode(results) };
  return { judgment, cost };
}

/**
 * Judges every rubric check of one question. The first check runs alone so the
 * shared question+response prefix is cached before the remaining checks run in
 * parallel. An empty answer (no submission) is graded without calling the model:
 * correctness checks fail, the contradiction check passes vacuously.
 */
export async function judgeQuestion(
  id: string,
  question: string,
  answer: string,
  rubric: RubricItem[],
  samples = 1,
): Promise<QuestionJudgment> {
  let cost = emptyCost();
  let checks: CheckJudgment[];
  if (!answer.trim()) {
    checks = rubric.map((item, index) => ({
      index,
      operator: item.operator,
      criteria: item.criteria,
      samples: [],
      verdict: item.operator === "contradiction" ? "pass" : "fail",
      skipped: "empty answer (no submit_final_result)",
    }));
  } else {
    const first = await judgeCheck(question, answer, rubric[0]!, 0, samples);
    cost = addCost(cost, first.cost);
    const rest = await Promise.all(rubric.slice(1).map((item, i) => judgeCheck(question, answer, item, i + 1, samples)));
    for (const r of rest) cost = addCost(cost, r.cost);
    checks = [first.judgment, ...rest.map((r) => r.judgment)];
  }
  const passed = checks.filter((c) => c.verdict === "pass").length;
  return { id, checks, all_pass: passed === checks.length, passed, total: checks.length, cost };
}
