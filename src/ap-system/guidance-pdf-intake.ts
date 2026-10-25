/** Local text-PDF demonstration adapter. Runs Poppler on the actual uploaded bytes. No OCR/model claims. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { AP_CONTRACT_VERSION, intakeSchema, type FieldEvidence } from "./contracts";
import type { PreparedUploadRequest } from "./intake-requests";
const exec=promisify(execFile),sha=(b:string|Uint8Array)=>createHash("sha256").update(b).digest("hex");
export async function parseGuidancePdf(input:PreparedUploadRequest) {
 if(input.uploads.length!==1)throw Error("Upload one synthetic invoice PDF per case");
 const u=input.uploads[0]!;
 if(!Buffer.from(u.bytes).subarray(0,5).equals(Buffer.from("%PDF-")))throw Error("A real PDF is required");
 const dir=await mkdtemp(path.join(tmpdir(),"ap-guidance-"));let text:string;
 try {const file=path.join(dir,"source.pdf");await writeFile(file,u.bytes);const info=await exec("pdfinfo",[file],{timeout:20000});if(!/^Pages:\s+1\s*$/m.test(info.stdout))throw Error("This bounded demo parser requires a one-page PDF");await exec("pdftotext",["-layout",file,path.join(dir,"text.txt")],{timeout:20000,maxBuffer:1024*1024});text=await readFile(path.join(dir,"text.txt"),"utf8");}finally{await rm(dir,{recursive:true,force:true});}
 if(!text.includes("SYNTHETIC DEMONSTRATION"))throw Error("This local adapter only accepts visibly synthetic text PDFs");
 const one=(label:string)=>{const matches=[...text.matchAll(new RegExp(`^${label}:\\s*([^\\r\\n]+)`,"gm"))];return matches.length===1?matches[0]![1]!.trim():null;};
 const hash=sha(u.bytes),binding={sourceId:u.sourceId??`pdf-${hash}`,revision:u.revision??1,sha256:hash};
 const processor={provider:"Poppler pdftotext",model:null,version:"local-text-pdf-v1",configHash:sha("pdftotext -layout"),jobId:null,resolvedVersion:null,implementationVersion:"guidance-pdf-v1",configArtifact:null,rawArtifact:null,tokenArtifact:null,rasterArtifact:null,traineddata:null};
 const source={...binding,deliveryId:u.deliveryId??`upload-${hash}`,name:u.name,kind:"invoice" as const,mimeType:"application/pdf",originalRef:`retained:${hash}`,originalBase64:Buffer.from(u.bytes).toString("base64"),byteLength:u.bytes.length,extractedText:text,provenance:u.provenance??{kind:"synthetic" as const,description:"Uploaded synthetic PDF; text extracted locally with Poppler. No live model or real human sign-off.",license:"CC0 synthetic demo",originalFilename:u.name},replaces:u.replaces??null,pageCount:1,pageStatus:[{page:1,status:"complete" as const,reason:null}],parser:processor};
 const fields=[['supplierId','Supplier ID'],['extractedSupplierName','Supplier'],['invoiceNumber','Invoice number'],['invoiceDate','Invoice date'],['currency','Currency'],['totalCents','Total cents'],['category','Service category'],['location','Location'],['description','Description']] as const;
 const evidence:FieldEvidence[]=fields.filter(([,label])=>one(label)!==null).map(([field,label])=>({evidenceId:`${hash}-${field}`,source:binding,fieldPath:field,rawValue:one(label)!,normalizedValue:one(label)!,contentStatus:"supported",quote:`${label}: ${one(label)}`,grounding:{status:"unresolved",method:"none",page:1,frame:null,regions:[],contextRegions:[],normalization:"html_decode+nfc+whitespace+casefold;no_character_substitution",processor,failureReason:"Text extracted from PDF; precise glyph coordinates are not claimed",elementPath:null}}));
 const amount=Number(one("Total cents")),required=["Supplier ID","Supplier","Invoice number","Invoice date","Currency","Total cents","Description"];
 const complete=required.every(l=>one(l)!==null)&&Number.isSafeInteger(amount)&&amount>0;
 return intakeSchema.parse({contractVersion:AP_CONTRACT_VERSION,idempotencyKey:input.idempotencyKey,documents:[source],explicitRevisionOf:input.explicitRevisionOf,purchasingEvidence:[],extraction:{status:complete?"complete":"incomplete",evidence,reasons:complete?[]:["Missing or ambiguous required invoice fields"]},candidate:complete?{candidateId:`candidate-${hash}`,revision:binding.revision,sources:[binding],extractedSupplierName:one("Supplier"),supplierId:one("Supplier ID"),invoiceNumber:one("Invoice number"),invoiceDate:one("Invoice date"),dueDate:null,terms:null,currency:one("Currency"),kind:"invoice",appliesToBillId:null,lines:[{lineId:"service-1",sku:null,description:one("Description"),quantity:{decimal:"1",unit:"service"},unitPriceCents:amount,amountCents:amount,taxCents:0,evidenceIds:evidence.map(e=>e.evidenceId),poLineId:null,receiptLineIds:[],allocations:[]}],freightAllocations:[],discountAllocations:[],subtotalCents:amount,taxCents:0,freightCents:0,discountCents:0,totalCents:amount,evidence,parseWarnings:["Synthetic local text parser; coding remains a separately reviewed recommendation"]}:null});
}
