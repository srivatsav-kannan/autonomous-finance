/** Captures the issue #107 case in /ap-system as a simulated actor. Read-only: it never clicks an action button. */
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const [stage, actor = "treasury", which = "case1"] = process.argv.slice(2);
if (!stage || !/^[a-z0-9-]+$/.test(stage)) throw Error("Usage: apex-replay-screens.ts <stage> [actor]");
const proof = JSON.parse(readFileSync(`var/apex107-replay-20261025/${which === "case2" ? "case2" : "case1-intake"}.json`, "utf8"));
const caseId = proof.caseId as string, invoiceNumber = which === "case2" ? "AVILA-202403-A1" : "AVILA-202412-A6";
const out = path.join("docs/ap-orchestration/evidence/apex-107/screens");
mkdirSync(out, { recursive: true });
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:5197/ap-system?case=${encodeURIComponent(caseId)}`);
  const select = page.getByRole("combobox").first();
  await select.waitFor({ timeout: 30000 });
  await select.selectOption(actor);
  await page.getByRole("heading", { name: invoiceNumber, exact: true }).waitFor({ timeout: 30000 });
  for (const tab of ["Source & fields", "Matching", "Accounting", "History"]) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    await page.waitForTimeout(1500);
    const file = path.join(out, `${stage}-${tab.toLowerCase().replace(/[^a-z]+/g, "-").replace(/-$/, "")}.jpg`);
    await page.screenshot({ path: file, fullPage: true, type: "jpeg", quality: 70 });
    console.log(file);
  }
} finally { await browser.close(); }
