import { it, expect } from "vitest";
import { businessFixture, acceptance } from "../../../tests/ap-system/business-fixture";
it("smoke", async () => { const f = await businessFixture(); const r = await f.recognize(f.detail, acceptance(f.input, "1")); expect(r.status).toBe("approved"); });
