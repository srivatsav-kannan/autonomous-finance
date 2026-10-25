import type {AcceptedLine,BusinessAcceptance,BusinessPolicy} from "../../src/ap-system/domain-contracts";
import {headerTaxBase,taxHeaderProblems} from "../../src/ap-system/tax-header";
import type {APCaseDetail,SourceDocument} from "../../src/ap-system/contracts";
import {taxClaimSchema,taxCitationSchema,type TaxClaim,type TaxCitation,type RecoverableTaxPolicy} from "../../src/ap-system/tax-contracts";
import {taxClaimProblems,citedRate} from "../../src/ap-system/tax-policy";
import {accountingAmountInput} from "./apSystemView";
export const taxSourceKey=(s:{sourceId:string;revision:number;sha256:string})=>`${s.sourceId}:${s.revision}:${s.sha256}`;
export type CitationDraft={source:string;page:string;start:string;end:string;quote:string;rawValue:string;unit:""|"major"|"minor"};
export const blankCitation=():CitationDraft=>({source:"",page:"",start:"",end:"",quote:"",rawValue:"",unit:""});
export type TaxDraft={basisSource:""|"printed"|"derived";calculation:""|TaxClaim["calculation"];jurisdiction:string;taxPointDate:string;priceBasis:""|TaxClaim["priceBasis"];rate:string;base:string;tax:string;gross:string;recoverable:string;facts:Record<"net"|"base"|"tax"|"gross"|"date"|"priceBasis"|"jurisdiction"|"rate",CitationDraft>;eligibility:CitationDraft[];rationale:string};
export const blankTaxDraft=():TaxDraft=>({basisSource:"",calculation:"",jurisdiction:"",taxPointDate:"",priceBasis:"",rate:"",base:"",tax:"",gross:"",recoverable:"",facts:{net:blankCitation(),base:blankCitation(),tax:blankCitation(),gross:blankCitation(),date:blankCitation(),priceBasis:blankCitation(),jurisdiction:blankCitation(),rate:blankCitation()},eligibility:[],rationale:""});
export function taxDocuments(detail:APCaseDetail){return detail.sources.filter(s=>detail.currentSourceBindings.some(b=>taxSourceKey(b)===taxSourceKey(s)));}
export function buildTaxCitation(draft:CitationDraft,documents:SourceDocument[],money=false){
 const doc=documents.find(s=>taxSourceKey(s)===draft.source);if(!doc)throw Error("Choose an exact current source for each tax citation.");
 const integer=(s:string)=>/^\d+$/.test(s)?Number(s):Number.NaN;
 const citation=taxCitationSchema.parse({source:{sourceId:doc.sourceId,revision:doc.revision,sha256:doc.sha256},page:integer(draft.page),start:integer(draft.start),end:integer(draft.end),quote:draft.quote,rawValue:draft.rawValue});
 if(citation.end<=citation.start||doc.extractedText.slice(citation.start,citation.end)!==citation.quote||!citation.quote.includes(citation.rawValue)||!doc.pageStatus.some(p=>p.page===citation.page&&p.status==="complete"))throw Error("Tax evidence must match the exact retained text, raw value and complete page.");
 if(money&&draft.unit!=="major"&&draft.unit!=="minor")throw Error("Choose whether the printed monetary value is dollars or cents.");
 return {...citation,...(money?{unit:draft.unit}:{})};
}
export function buildTaxClaim(draft:TaxDraft,detail:APCaseDetail,lineId:string,acceptedTaxCents:number,rule:RecoverableTaxPolicy,header?:AcceptedLine["headerAllocation"]):TaxClaim{
 const documents=taxDocuments(detail),invoices=documents.filter(s=>s.kind==="invoice"),eligibility=documents.filter(s=>["other","contract","correction"].includes(s.kind)&&!invoices.some(i=>i.sha256===s.sha256));
 const money=(s:string)=>{const n=accountingAmountInput(s,true);if(n===undefined)throw Error("Enter each exact tax amount.");return n;};
 const original=detail.candidate?.lines.find(l=>l.lineId===lineId),source=detail.candidate?.evidence.find(e=>e.fieldPath===`lines.${lineId}.taxCents`&&e.contentStatus==="supported")?.source;
 if(!original||!source)throw Error("The original line needs supported tax evidence before a recovery claim can be reviewed.");
 if(!draft.basisSource)throw Error("Choose printed or explicitly derived taxable basis.");
 const derived=draft.basisSource==="derived";
 if(derived&&(!rule.headerBasis||!header))throw Error("Derived basis needs an approved header rule and explicit original/accepted line shares.");
 const derivedHeaderBasis=derived?{freight:rule.headerBasis!.freight,discount:rule.headerBasis!.discount}:undefined;
 const taxableBaseCents=derived?headerTaxBase(original.amountCents,header!.originalFreightCents,header!.originalDiscountCents,derivedHeaderBasis!):money(draft.base);
 const originalTaxCents=money(draft.tax),originalGrossCents=derived?taxableBaseCents+originalTaxCents:money(draft.gross);
 const facts=Object.fromEntries(Object.entries(draft.facts).filter(([k])=>(k!=="rate"||draft.calculation==="rate")&&(derived?!["base","gross"].includes(k):k!=="net")).map(([k,v])=>[k,buildTaxCitation(v,invoices,["net","base","tax","gross"].includes(k))]));
 const claim=taxClaimSchema.parse({calculation:draft.calculation,jurisdiction:draft.jurisdiction,taxPointDate:draft.taxPointDate,priceBasis:draft.priceBasis,rateBps:draft.calculation==="rate"?citedRate(draft.rate):null,taxableBaseCents,originalTaxCents,originalGrossCents,...(derivedHeaderBasis?{derivedHeaderBasis}:{}),recoverableCents:money(draft.recoverable),facts,eligibilityEvidence:draft.eligibility.map(c=>buildTaxCitation(c,eligibility)),eligibilityRationale:draft.rationale});
 const errors=taxClaimProblems(claim,rule,documents,{...original,source,...(derived?{taxableBaseCents}:{})},acceptedTaxCents);if(errors.length)throw Error(`Tax claim needs review: ${errors.join(", ")}`);return claim;
}
export function citationDraft(c:TaxCitation&{unit?:"major"|"minor"}):CitationDraft{return{source:taxSourceKey(c.source),page:String(c.page),start:String(c.start),end:String(c.end),quote:c.quote,rawValue:c.rawValue,unit:c.unit??""};}
export function taxDraftFromClaim(c:TaxClaim):TaxDraft{return{...blankTaxDraft(),basisSource:c.derivedHeaderBasis?"derived":"printed",calculation:c.calculation,jurisdiction:c.jurisdiction,taxPointDate:c.taxPointDate,priceBasis:c.priceBasis,rate:c.rateBps===null?"":`${c.rateBps/100}%`,base:(c.taxableBaseCents/100).toFixed(2),tax:(c.originalTaxCents/100).toFixed(2),gross:(c.originalGrossCents/100).toFixed(2),recoverable:(c.recoverableCents/100).toFixed(2),facts:{...blankTaxDraft().facts,...Object.fromEntries(Object.entries(c.facts).filter(([,v])=>!!v).map(([k,v])=>[k,citationDraft(v!)]))},eligibility:c.eligibilityEvidence.map(citationDraft),rationale:c.eligibilityRationale};}

export function validateTaxHeaders(detail:APCaseDetail,acceptance:BusinessAcceptance,policy:BusinessPolicy){
 const errors=taxHeaderProblems({candidate:detail.candidate,documents:taxDocuments(detail)} as Parameters<typeof taxHeaderProblems>[0],acceptance,policy);
 if(errors.length)throw Error(`Tax header attribution needs review: ${errors.join(", ")}`);
}
