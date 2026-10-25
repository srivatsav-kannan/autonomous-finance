import { it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { pageStatuses } from "./pages";
import { providerGrounding, groundText } from "./grounding";
import type { ProviderOutput } from "./provider";
const load = async () =>
  JSON.parse(
    await readFile(
      "fixtures/ap-system/parser-contract-v1/invoice.json",
      "utf8",
    ),
  ) as ProviderOutput;
it("requires complete, ordered and unique provider page identities", () => {
  expect(
    pageStatuses(2, [
      { page_number: 1, success: true },
      { page_number: 2, success: true },
    ]).map((p) => p.status),
  ).toEqual(["complete", "complete"]);
  for (const pages of [
    [{ page_number: 1, success: true }],
    [
      { page_number: 1, success: true },
      { page_number: 1, success: true },
    ],
    [
      { page_number: 2, success: true },
      { page_number: 1, success: true },
    ],
    [
      { page_number: 1, success: true },
      { page_number: 3, success: true },
    ],
  ])
    expect(pageStatuses(2, pages).some((p) => p.status !== "complete")).toBe(
      true,
    );
});
it("rejects native and raw geometry whose artifact page frame does not match", async () => {
  const o = await load();
  o.grounded[0]!.page_width = 999;
  o.rawWords[0]!.page_width = 999;
  const g = await groundText("INV-1001", providerGrounding(o));
  expect(g.status).toBe("unresolved");
  expect(g.regions).toEqual([]);
});
it("maps native and raw image coordinates to actual original pixels", async () => {
  const o = await load();
  o.result.__apOriginalFrames = [
    { page: 1, width: 1224, height: 1584, rotation: 0, units: "pixel" },
  ];
  const original = await groundText(
    "INV-1001",
    providerGrounding(await load()),
  );
  const mapped = await groundText("INV-1001", providerGrounding(o));
  expect(mapped.frame?.units).toBe("pixel");
  expect(mapped.frame?.width).toBe(1224);
  expect(mapped.regions[0]!.x).toBeCloseTo(original.regions[0]!.x * 2);
});
it("never accepts geometry from an incomplete/reordered source result", async () => {
  const o = await load();
  o.result.__apPageCoverageValid = false;
  expect((await groundText("INV-1001", providerGrounding(o))).status).toBe(
    "unresolved",
  );
});
