import fs from "node:fs";
import path from "node:path";
import type { FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter";

/** No raw errors, assertion values, stdout, HTML, traces or request bodies in CI artifacts. */
export default class PaymentBrowserReporter implements Reporter {
  private tests: object[] = [];
  private runnerErrors = 0;
  onError() { this.runnerErrors++; }
  onTestEnd(test: TestCase, result: TestResult) {
    this.tests.push({
      // Test names and source locations are repository-owned, never data from the page.
      scenario: test.title.slice(0, 120), status: result.status,
      durationMs: result.duration, line: test.location.line,
      errorCount: result.errors.length,
      failureLines: result.errors.slice(0, 3).map(error => {
        const line = error.stack?.match(/payment-journey\.pw\.ts:(\d+):\d+/)?.[1];
        return line ? Number(line) : null;
      }),
    });
  }
  onEnd(result: FullResult) {
    fs.writeFileSync(path.join(process.env.PAYMENT_BROWSER_ARTIFACTS!, "playwright.json"), JSON.stringify({
      status: result.status, runnerErrors: this.runnerErrors, tests: this.tests.slice(0, 10),
      redaction: "allowlisted metadata only; raw logs, DOM, JWTs and request headers omitted",
    }, null, 2), { mode: 0o600 });
  }
}
