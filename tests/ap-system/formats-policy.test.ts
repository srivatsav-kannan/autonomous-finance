import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, refs } from "./accounting-fixture";
import { parseUpload } from "../../src/ap-system/ingestion/index";
afterEach(()=>vi.unstubAllEnvs());
it("a correctly parsed native-path tax XML remains held without approved supplier, PO and receiving authority",async()=>{
  const root=await mkdtemp(join(tmpdir(),"ap97-xml-policy-"));
  try {
    const bytes=await readFile("fixtures/ap-system/formats-v1/input/invoice-ubl.xml");
    const input=await parseUpload({bytes,name:"invoice-ubl.xml",mimeType:"application/xml",storageRoot:root,sourceId:"tax-xml-source",revision:1,context:{supplier:{supplierId:"format-test-supplies",legalName:"Format Test Supplies LLC"},coding:{account:"5000",store:"test",department:null,project:null,treatment:"expense"}},provenance:{kind:"synthetic",description:"A3 strict XML fixture; not a trusted supplier master",license:"project authored",originalFilename:"invoice-ubl.xml"},options:{fetcher:async()=>{throw Error("XML has no hosted parse call");}}});
    expect(input.extraction.status).toBe("complete");expect(input.candidate).toMatchObject({totalCents:1890,taxCents:140});
    expect(input.candidate!.evidence.every(e=>e.grounding.method==="xml_path"&&e.grounding.regions.length===0)).toBe(true);
    const f=await fixture(),r=await f.t.mutation(refs.ingest,{...f.ap,input});let d=await f.get(r.caseId);
    expect(d.states.business).toBe("held");expect(d.amounts.acceptedCents).toBeNull();expect(d.exceptions.some(e=>e.blocking&&e.status==="open")).toBe(true);
    await f.fieldReviewer.mutation(refs.review,{scope:f.scope,input:f.request(d,"xml-fields")});d=await f.get(r.caseId);
    await expect(f.human.mutation(refs.approve,{scope:f.scope,input:{...f.request(d,"xml-approve"),acceptedCents:1890}})).rejects.toThrow();
    const rows=await f.t.run(async ctx=>({bills:await ctx.db.query("demoBills").collect(),entries:await ctx.db.query("journalEntries").collect(),payments:await ctx.db.query("demoVersions").collect()}));
    expect(rows).toEqual({bills:[],entries:[],payments:[]});
  } finally {await rm(root,{recursive:true,force:true});}
});
