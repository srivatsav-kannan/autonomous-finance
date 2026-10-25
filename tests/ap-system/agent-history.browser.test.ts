import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { expect, it } from "vitest";
import { startHistoryFixtureServer } from "../../scripts/testing/ap-history-fixture-server";

it("inspects stored operations in the mounted case workspace with keyboard, navigation and responsive layouts", async () => {
  const { server, url } = await startHistoryFixtureServer();
  const out = fileURLToPath(
    new URL("../../var/ap-history-ui/", import.meta.url),
  );
  await mkdir(out, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ??
      (existsSync(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      )
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : undefined),
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    timezoneId: "America/Los_Angeles",
  });
  const errors: string[] = [],
    requests: string[] = [],
    screenshots: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.url().includes("/api/"))
      requests.push(`${request.method()} ${request.url()}`);
  });
  const visit = async (fixture: string) => {
    await page.goto(`${url}ap-system?fixture=${fixture}`);
    await page
      .getByRole("heading", { name: "Audit timeline", exact: true })
      .waitFor();
  };
  const capture = async (name: string) => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
    screenshots.push(`${name}.png`);
    if (
      [
        "missing-receipt-light-1280",
        "payment-proposal",
        "settled-history",
      ].includes(name)
    ) {
      await page
        .locator(".aph-history")
        .screenshot({ path: `${out}/${name}-detail.png` });
      screenshots.push(`${name}-detail.png`);
    }
  };
  try {
    await visit("missing-receipt");
    const summary = page.locator(".aph-operation > summary").first();
    await summary.focus();
    await page.keyboard.press("Enter");
    expect(
      await page.locator(".aph-operation").getAttribute("open"),
    ).not.toBeNull();
    expect(await page.locator(".aph-operation-body").innerText()).toContain(
      "Accepted receiving evidence",
    );
    expect(
      await summary.evaluate((e) => getComputedStyle(e).outlineStyle),
    ).toBe("solid");
    await page.keyboard.press("Space");
    expect(
      await page.locator(".aph-operation").getAttribute("open"),
    ).toBeNull();
    await page.keyboard.press("Enter");
    await page.getByText(/^Unchanged recorded fields/).click();
    expect(await page.locator(".aph-operation-body").innerText()).toContain(
      "Unknown (recorded null)",
    );
    expect(await page.locator(".aph-operation-body").innerText()).toContain(
      "0.00 (0 cents)",
    );
    await page.getByText(/^Unchanged recorded fields/).click();
    for (const scheme of ["light", "dark"] as const)
      for (const width of [1280, 1440, 390]) {
        await page.emulateMedia({
          colorScheme: scheme,
          reducedMotion: "reduce",
        });
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(() => new Promise(requestAnimationFrame));
        expect(
          await page.evaluate(
            () =>
              document.documentElement.scrollWidth <= innerWidth &&
              document.body.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        expect(
          await page
            .locator(".aph-operation")
            .evaluate((e) => e.scrollWidth <= e.clientWidth),
        ).toBe(true);
        await capture(`missing-receipt-${scheme}-${width}`);
      }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ colorScheme: "light" });
    await visit("evidence-revision");
    await page.locator(".aph-operation > summary").first().click();
    await page
      .getByText(/^Unchanged recorded fields/)
      .first()
      .click();
    expect(await page.locator(".aph-operation").first().innerText()).toContain(
      "receipt-GS-1042",
    );
    expect(
      await page
        .locator(".aph-operation")
        .first()
        .getByRole("row", { name: "Case revision 2 2" })
        .count(),
    ).toBe(1);
    await capture("evidence-revision");

    await visit("independent-approval");
    const approval = page.locator(".aph-operation").nth(1);
    await approval.locator(":scope > summary").click();
    expect(await approval.locator(".aph-observed").innerText()).toContain(
      "bill approved",
    );
    await approval.getByText(/^Recorded references/).click();
    await approval
      .getByRole("link", { name: "View recorded decision" })
      .first()
      .click();
    expect(await page.locator("li:target").innerText()).toContain(
      "Compared every field",
    );
    await capture("independent-approval");

    await visit("payment-proposal");
    await page.locator(".aph-operation > summary").click();
    await page.getByText(/^Recorded references/).click();
    const payment = page
      .locator(".aph-references > li")
      .filter({ has: page.getByText("Payment", { exact: true }) });
    expect(await payment.innerText()).toContain("After only");
    expect(await payment.locator("a,button").count()).toBe(0);
    expect(await page.locator(".aph-observed").innerText()).toContain(
      "bank execution not started",
    );
    await capture("payment-proposal");

    await visit("settled");
    await page.locator(".aph-operation > summary").last().click();
    expect(
      await page
        .locator(".aph-operation")
        .last()
        .locator(".aph-observed")
        .innerText(),
    ).toContain("bank execution settled");
    await page
      .getByText(/^Recorded references/)
      .last()
      .click();
    await capture("settled-history");
    await page
      .getByRole("button", { name: "View journal in Accounting" })
      .last()
      .click();
    expect(
      await page
        .getByRole("button", { name: "Accounting", exact: true })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await page.getByRole("button", { name: "History", exact: true }).click();
    await page
      .getByRole("heading", { name: "Audit timeline", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page
      .getByRole("heading", { name: "Audit timeline", exact: true })
      .waitFor();

    await visit("legacy");
    expect(await page.locator(".aph-operation").count()).toBe(0);
    expect(await page.locator(".aph-history").innerText()).toContain(
      "Legacy worker event.",
    );
    await capture("legacy-history");
    await visit("empty");
    expect(await page.locator(".aph-empty").innerText()).toBe(
      "No historical events are available.",
    );
    await capture("empty-history");
    await visit("long");
    await page.locator(".aph-operation > summary").click();
    await page
      .getByText("Operation details and lease identifiers", { exact: true })
      .click();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page
        .locator(".aph-operation")
        .evaluate((e) => e.scrollWidth <= e.clientWidth),
    ).toBe(true);
    await capture("long-ids-phone");
    expect(errors).toEqual([]);
    expect(requests).toEqual([]);
    await writeFile(
      `${out}/report.json`,
      JSON.stringify(
        {
          status: "passed",
          scope:
            "Mounted browser fixtures only; no backend, model, provider or financial workflow executed",
          screenshots,
          errors,
          apiRequests: requests,
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
    await server.close();
  }
}, 90000);
