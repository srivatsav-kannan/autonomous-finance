import {afterEach,it,expect,vi} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {APTimingRecords,APTimingSummary,APSystemTimings,elapsedLabel,timingsMatchCases,timingSummary} from "../console/src/APSystemTimings";
import {apSystemApi} from "../console/src/apSystemApi";
import {configureAPSession} from "../console/src/apAuthSession";
import {timingUIFixture} from "./ap-system-timing-ui.fixture";
import {apUIFixture} from "./ap-system-ui.fixture";
afterEach(()=>{configureAPSession(null);vi.unstubAllGlobals();});
it("keeps completed median, ongoing oldest and missing coverage separate",()=>{
 const cases=[apUIFixture(),{...apUIFixture(),caseId:"second"},{...apUIFixture(),caseId:"third"}],data=timingUIFixture(cases),samples=data.cases.flatMap(c=>c.samples);
 expect(timingSummary(samples,"review_to_post")).toEqual({completed:2,median:120_000,ongoing:1,oldest:900_000,unavailable:0,notStarted:0});
 const html=renderToStaticMarkup(<APTimingSummary data={data}/>);expect(html).toContain("Median 2m 0s");expect(html).toContain("Oldest 15m 0s");expect(html).toContain("3 not measurable / 0 not started");expect(html).toContain("No completed measurement");expect(elapsedLabel(null)).toBe("Not measurable");expect(elapsedLabel(0)).toBe("0 ms");
});
it("exposes exact event, source and payment-run evidence without relabeling unknown history as current",()=>{
 const data=timingUIFixture([apUIFixture()]),s=data.cases[0]!.samples[0]!;s.revision=null;s.snapshotHash=null;s.paymentVersionId="version-history";s.paymentSnapshotHash="e".repeat(64);s.paymentRunIds=["run-history"];
 const html=renderToStaticMarkup(<APTimingRecords samples={[s]}/>);for(const text of ["Historical source revision not recorded","version-history","run-history","synthetic-event:","Synthetic persisted-event","Completion"])expect(html).toContain(text);expect(html).not.toContain("Source revision 1");
});
it("rejects timing snapshots for another scope, revision, hash or case set",()=>{
 const c=apUIFixture(),data=timingUIFixture([c]);expect(timingsMatchCases(data,[c])).toBe(true);
 for(const changed of [{...c,revision:2},{...c,snapshotHash:"b".repeat(64)},{...c,scope:{...c.scope,accountId:"other"}},{...c,caseId:"different"}])expect(timingsMatchCases(data,[changed])).toBe(false);
 expect(timingsMatchCases(data,[])).toBe(false);expect(timingsMatchCases({...data,asOf:NaN},[c])).toBe(false);
});
it("states fixed snapshot and overlapping intervals without invented latency or worker progress",()=>{
 const html=renderToStaticMarkup(<APSystemTimings cases={[]}/>);expect(html).toContain("No cases to measure");expect(html).toContain("overlapping intervals are not total processing time");expect(html).not.toContain("0 ms");
});
it("fetches only the authenticated read endpoint and forwards cancellation",async()=>{
 const fetcher=vi.fn(async(_url:string,_init?:RequestInit)=>new Response(JSON.stringify(timingUIFixture([apUIFixture()])),{status:200}));vi.stubGlobal("fetch",fetcher);configureAPSession({mode:"local"});const abort=new AbortController();await apSystemApi.operationalTimings(abort.signal);
 expect(fetcher.mock.calls[0]![0]).toBe("/api/ap-system/metrics");expect(fetcher.mock.calls[0]![1]?.method??"GET").toBe("GET");expect(fetcher.mock.calls[0]![1]?.body).toBeUndefined();expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(false);abort.abort();expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(true);
});
