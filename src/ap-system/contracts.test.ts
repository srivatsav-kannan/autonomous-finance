import { describe, expect, it } from "vitest";
import { frameSchema, groundingSchema, reviewRequestSchema, sourceDocumentSchema } from "./contracts";
const sha = "a".repeat(64);
const frame={width:100,height:200,units:"point",origin:"top_left",rotation:0,transform:[1,0,0,1,0,0]};
const processor={provider:"tesseract",model:null,version:"5.5.2",configHash:sha,jobId:null,resolvedVersion:"5.5.2",implementationVersion:"test-v1",configArtifact:null,rawArtifact:null,tokenArtifact:null,rasterArtifact:null,traineddata:null};
const base={status:"derived",method:"local_ocr_exact",page:1,frame,regions:[{x:10,y:20,width:30,height:10,granularity:"line",tokenRefs:["word-1"]}],contextRegions:[],normalization:"html_decode+nfc+whitespace+casefold;no_character_substitution",processor,failureReason:null,elementPath:null};
describe("frozen evidence trust boundaries",()=>{
  it("rejects singular transforms",()=>expect(frameSchema.safeParse({...frame,transform:[0,0,0,0,0,0]}).success).toBe(false));
  it("accepts derived word-backed line locations and rejects invented cell borders",()=>{
    expect(groundingSchema.safeParse(base).success).toBe(true);
    expect(groundingSchema.safeParse({...base,regions:[{...base.regions[0],granularity:"cell"}]}).success).toBe(false);
  });
  it("never uses coarse context as precise evidence",()=>expect(groundingSchema.safeParse({...base,status:"native",method:"native",regions:[{...base.regions[0],granularity:"table"}]}).success).toBe(false));
  it("retains unresolved reasons without precise boxes",()=>{
    expect(groundingSchema.safeParse({...base,status:"unresolved",method:"none",regions:[],failureReason:"ambiguous"}).success).toBe(true);
    expect(groundingSchema.safeParse({...base,status:"unresolved",method:"none",failureReason:"ambiguous"}).success).toBe(false);
  });
  it("rejects out-of-frame regions and dangling review sources",()=>{
    expect(groundingSchema.safeParse({...base,regions:[{...base.regions[0],x:90}]}).success).toBe(false);
    expect(reviewRequestSchema.safeParse({caseId:"case",expectedRevision:1,snapshotHash:sha,idempotencyKey:"key",outcome:"approved",reason:"Reviewed original",evidenceIds:[]}).success).toBe(false);
  });
  it("requires complete and unique page inventory",()=>{
    const source={sourceId:"doc",revision:1,sha256:sha,deliveryId:"delivery",name:"invoice.pdf",kind:"invoice",mimeType:"application/pdf",originalRef:"private/original",byteLength:10,extractedText:"",provenance:{kind:"synthetic",description:"test",license:"project synthetic",originalFilename:"invoice.pdf"},replaces:null,pageCount:2,pageStatus:[{page:1,status:"complete",reason:null},{page:1,status:"complete",reason:null}],parser:null};
    expect(sourceDocumentSchema.safeParse(source).success).toBe(false);
    expect(sourceDocumentSchema.safeParse({...source,pageStatus:[{page:1,status:"complete",reason:null},{page:2,status:"failed",reason:"unreadable"}]}).success).toBe(true);
  });
});
