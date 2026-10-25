// The fixed situation behind `npm run scenario` and the default run for `npm run ask`.
import type { WorldOptions } from "../../src/world/generate";

export const SCENARIO_RUN = "scenario-1";

export const SCENARIO_OPTIONS: WorldOptions = { seed: 7, storeCount: 3, start: "2026-01-01", days: 14, plantErrors: true };

/** Questions the scenario-1 record can answer, printed in the briefing. */
export const EXAMPLE_QUESTIONS = [
  "Why was INV-1002 held?",
  "Who approved the Embarcadero rent payment?",
  "What happened with the bank-detail change request from Golden State Produce?",
  "Why is the close blocked?",
  "Which payroll entry was held and why?",
] as const;
