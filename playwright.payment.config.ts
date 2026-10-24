import { defineConfig, devices } from "@playwright/test";

if (!process.env.PAYMENT_BROWSER_FIXTURE || !process.env.PAYMENT_BROWSER_ARTIFACTS || !process.env.PAYMENT_BROWSER_PRIVATE_OUTPUT) {
  throw new Error("Use the payment-browser-local or payment-browser-staging runner");
}

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "**/*.pw.ts", // Deliberately outside Vitest's *.test/spec discovery.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 60_000,
  globalTimeout: 180_000,
  expect: { timeout: 10_000 },
  outputDir: process.env.PAYMENT_BROWSER_PRIVATE_OUTPUT,
  reporter: [["./scripts/testing/payment-browser-reporter.ts"]],
  use: {
    ...devices["Desktop Chrome"],
    headless: true,
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    // A trace records fill() arguments and Authorization headers. Never record JWTs.
    trace: "off",
    screenshot: "off",
    video: "off",
    serviceWorkers: "block",
  },
});
