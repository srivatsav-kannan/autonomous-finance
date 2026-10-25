import { describe, expect, it } from "vitest";
import { isLocalSimulationOrigin } from "../console/src/apLocalSimulationOrigin";
const runtime = { identityMode: "simulated_human", runId: "ap97-i3-20261025", scope: { runId: "ap97-i3-20261025", provider: "fake", environment: "local", organizationId: "ap97-i3-synthetic-company", accountId: "ap97-i3-usd-operating" } };
describe("isolated local rehearsal origin", () => {
  it("retains the existing simulation origin and admits the exact I3 dev workspace", () => {
    expect(isLocalSimulationOrigin(runtime, "http://127.0.0.1:5193", false)).toBe(true);
    expect(isLocalSimulationOrigin(runtime, "http://127.0.0.1:5195", true)).toBe(true);
  });
  it("admits the combined console from npm run demo, only for simulated identities", () => {
    expect(isLocalSimulationOrigin(runtime, "http://127.0.0.1:5173", false)).toBe(true);
    expect(isLocalSimulationOrigin({ ...runtime, identityMode: "auth0" }, "http://127.0.0.1:5173", true)).toBe(false);
  });
  it("rejects production builds, external origins and the real Auth0 origin", () => {
    expect(isLocalSimulationOrigin(runtime, "http://127.0.0.1:5195", false)).toBe(false);
    for (const origin of ["http://127.0.0.1:5192", "http://localhost:5195", "https://127.0.0.1:5195", "https://example.com"]) expect(isLocalSimulationOrigin(runtime, origin, true)).toBe(false);
  });
  it("rejects external or mismatched identities and scopes", () => {
    for (const bad of [null, {}, {...runtime, identityMode: "auth0"}, {...runtime, runId: "other"}, {...runtime, scope: undefined}, ...Object.entries({runId:"other",provider:"increase",environment:"sandbox",organizationId:"other",accountId:"other"}).map(([key,value])=>({...runtime,scope:{...runtime.scope,[key]:value}}))]) expect(isLocalSimulationOrigin(bad, "http://127.0.0.1:5195", true)).toBe(false);
  });
  it("admits the issue #107 replay only on its own origin, run and scope", () => {
    const apex = { identityMode: "simulated_human", runId: "apex107-replay-20261025", scope: { runId: "apex107-replay-20261025", provider: "fake", environment: "local", organizationId: "apex107-synthetic-sterling-marsh", accountId: "apex107-usd-operating" } };
    expect(isLocalSimulationOrigin(apex, "http://127.0.0.1:5197", true)).toBe(true);
    expect(isLocalSimulationOrigin(apex, "http://127.0.0.1:5197", false)).toBe(false);
    expect(isLocalSimulationOrigin(apex, "http://127.0.0.1:5195", true)).toBe(false);
    expect(isLocalSimulationOrigin(runtime, "http://127.0.0.1:5197", true)).toBe(false);
    for (const [key, value] of Object.entries({ provider: "increase", environment: "sandbox", organizationId: "other", accountId: "other" })) expect(isLocalSimulationOrigin({ ...apex, scope: { ...apex.scope, [key]: value } }, "http://127.0.0.1:5197", true)).toBe(false);
  });
});

it("admits uploaded guidance only for its exact dev origin and isolated scope",()=>{
 const guidance={identityMode:"simulated_human",runId:"ap97-b3-guidance-20261025-v1",scope:{runId:"ap97-b3-guidance-20261025-v1",provider:"fake",environment:"local",organizationId:"ap97-b3-synthetic-company",accountId:"ap97-b3-usd-operating"}};
 expect(isLocalSimulationOrigin(guidance,"http://127.0.0.1:5198",true)).toBe(true);
 expect(isLocalSimulationOrigin(guidance,"http://127.0.0.1:5198",false)).toBe(false);
 expect(isLocalSimulationOrigin(runtime,"http://127.0.0.1:5198",true)).toBe(false);
 expect(isLocalSimulationOrigin({...guidance,scope:{...guidance.scope,provider:"increase"}},"http://127.0.0.1:5198",true)).toBe(false);
});
