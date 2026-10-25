import { createRoot } from "react-dom/client";
import { App } from "../../console/src/App";
import { apSystemApi } from "../../console/src/apSystemApi";
import {
  evidenceRevision,
  historyFixture,
  historyFixtures,
  type HistoryFixture,
} from "./agent-history.fixture";
import "../../console/src/styles.css";

const params = new URLSearchParams(location.search);
const requested = params.get("fixture") ?? "all";
const mode = Object.hasOwn(historyFixtures, requested)
  ? (requested as HistoryFixture)
  : "all";
const detail = historyFixture(mode);
params.set("case", detail.caseId);
if (!params.has("apView")) params.set("apView", "history");
history.replaceState(null, "", `/ap-system?${params}`);
// This isolated mounted workspace has no service connection or write path.
window.fetch = async (input) => {
  if (input === "/api/ap-system/runtime")
    return new Response(JSON.stringify({ identityMode: "simulated_human" }), {
      headers: { "Content-Type": "application/json" },
    });
  throw new Error("Stored fixture viewer: external requests are disabled.");
};
apSystemApi.list = async () => [detail];
apSystemApi.detail = async () => structuredClone(detail);

createRoot(document.getElementById("root")!).render(
  <>
    <div className="shell">
      <header className="top">
        <div>
          <h1 className="title">Stored AP history fixtures</h1>
          <p className="sub">
            Browser evidence only. Synthetic documents, simulated humans and
            local FakeBank; no new financial workflow.
          </p>
          <p className="sub">
            Snapshots: PR #113 at <code>{evidenceRevision.slice(0, 12)}</code>.
            Case context: prior stored fixture. No model or external provider
            execution.
          </p>
          <label>
            Stored fixture{" "}
            <select
              value={mode}
              onChange={(e) => {
                params.set("fixture", e.target.value);
                params.set("apView", "history");
                location.search = params.toString();
              }}
            >
              {Object.entries(historyFixtures).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>
    </div>
    <App hasSimulation={false} />
  </>,
);
