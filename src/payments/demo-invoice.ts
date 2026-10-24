import { generateWorld } from "../world/generate";
import { BUILTIN_PARSERS } from "../integrations/parsers";
import { VENDORS } from "../../company/sweetgreen/profile";

/** Worldsim supplies source documents only. Agent code never receives its evaluator answer key. */
export function demoInvoice(seed = 7, start = "2026-01-05") {
  const { events } = generateWorld({ seed, start, days: 1, storeCount: 1, plantErrors: false });
  for (const event of events) {
    if (event.type !== "document.received" || event.payload.kind !== "invoice") continue;
    const text = String(event.payload.text);
    const parser = BUILTIN_PARSERS.find(p => p.detect(text));
    const vendor = VENDORS.find(v => v.contact.email === event.payload.from);
    if (!parser || !vendor) continue;
    const invoice = parser.parse(text);
    return { event, invoice, vendor: vendor.id, seed };
  }
  throw new Error("Worldsim did not supply a supported demo invoice");
}
