import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { APSystemBusiness } from "../console/src/APSystemBusiness";
import { APAccounting, APActions } from "../console/src/APSystemWorkspace";
import { runEligible } from "../console/src/APSystemRuns";
import { apUIFixture } from "./ap-system-ui.fixture";

it("shows the historical restriction and suppresses approval/payment even with an old approved projection", () => {
  const detail = apUIFixture(), c = detail.candidate!;
  detail.states.document = "reviewed"; detail.states.business = "approved";
  detail.links.billId = "old-bill"; detail.links.recognitionJournalId = "old-journal"; detail.amounts.outstandingCents = c.totalCents;
  detail.historicalPaymentHold = { version: "historical-payment-hold-v1", supplierId: c.supplierId!, invoiceNumber: c.invoiceNumber,
    currency: "USD", amountCents: c.totalCents, invoiceSourceSha256: detail.sources[0]!.sha256, paidDate: "2026-10-25",
    reference: "HISTORICAL-CHECK", sourceSystem: "synthetic-test", sourceRevision: "v1", sourceRecordId: "HISTORICAL-BILL", evidence: [{ name: "ledger.csv", sha256: "a".repeat(64) }] };
  const props = { detail, busy: false, onBusy: () => {}, onChanged: () => {} };
  const business = renderToStaticMarkup(<APSystemBusiness {...props} cases={[detail]} onOpenCase={() => {}} />);
  expect(business).toContain("Historical payment hold"); expect(business).toContain("HISTORICAL-BILL");
  expect(business).toContain("$105.50"); expect(business).not.toContain("Propose business approval");
  expect(business).not.toContain("Approve current business stage");
  expect(renderToStaticMarkup(<APAccounting {...props} />)).not.toContain("Prepare payment proposal");
  expect(runEligible(detail)).toBe(false);
  detail.states.business = "held";
  expect(renderToStaticMarkup(<APActions {...props} />)).toMatch(/disabled="">Approve bill/);
});
