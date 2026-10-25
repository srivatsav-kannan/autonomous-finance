import { z } from "zod";

/** Owned by Master. Additive changes require a recorded contract version. */
export const AP_CONTRACT_VERSION = "ap-evidence-v1" as const;
export const AP_POLICY_VERSION = "golden-state-ap-v1" as const;
const id = z.string().trim().min(1);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const centsSchema = z.number().int().safe().nonnegative();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
  const d = new Date(`${v}T00:00:00Z`); return Number.isFinite(d.valueOf()) && d.toISOString().slice(0, 10) === v;
}, "Invalid calendar date");
export const sourceBindingSchema = z.object({ sourceId: id, revision: z.number().int().positive(), sha256: hash });
export const frameSchema = z.object({
  width: z.number().positive().finite(), height: z.number().positive().finite(),
  units: z.enum(["pixel", "point"]), origin: z.literal("top_left"),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
  // Affine [a,b,c,d,e,f]: original source coordinates -> displayed page coordinates.
  transform: z.tuple([z.number().finite(),z.number().finite(),z.number().finite(),z.number().finite(),z.number().finite(),z.number().finite()]),
}).refine(f => Math.abs(f.transform[0]*f.transform[3]-f.transform[1]*f.transform[2]) > 1e-12, "Coordinate transform must be invertible");
export const regionSchema = z.object({
  x: z.number().nonnegative().finite(), y: z.number().nonnegative().finite(),
  width: z.number().positive().finite(), height: z.number().positive().finite(),
  granularity: z.enum(["word", "line", "cell", "page", "table"]), tokenRefs: z.array(id),
});
export const artifactRefSchema = z.object({ ref:id, sha256:hash });
export const processorSchema = z.object({
  provider: id, model: z.string().nullable(), version: id, configHash: hash,
  jobId: z.string().nullable(), resolvedVersion: z.string().nullable(),
  implementationVersion:id, configArtifact:artifactRefSchema.nullable(), rawArtifact:artifactRefSchema.nullable(),
  tokenArtifact:artifactRefSchema.nullable(), rasterArtifact:artifactRefSchema.nullable(),
  traineddata: z.object({language:id, version:id, sha256:hash}).nullable(),
});
export const groundingSchema = z.object({
  status: z.enum(["native", "derived", "unresolved"]),
  method: z.enum(["native", "raw_word_exact", "local_ocr_exact", "none", "xml_path"]),
  page: z.number().int().positive().nullable(), frame: frameSchema.nullable(),
  regions: z.array(regionSchema), contextRegions: z.array(regionSchema),
  normalization: z.literal("html_decode+nfc+whitespace+casefold;no_character_substitution"),
  processor: processorSchema, failureReason: z.string().nullable(), elementPath: z.string().nullable(),
}).superRefine((g, ctx) => {
  if (g.status === "unresolved" && (g.regions.length || !g.failureReason)) ctx.addIssue({code:"custom",message:"Unresolved geometry requires a reason and no precise regions"});
  if (g.status !== "unresolved" && g.method !== "xml_path" && (!g.page || !g.frame || !g.regions.length)) ctx.addIssue({code:"custom",message:"Resolved geometry requires a page, frame and regions"});
  if (g.status === "native" && !["native","xml_path"].includes(g.method) || g.status === "derived" && !["raw_word_exact","local_ocr_exact"].includes(g.method)) ctx.addIssue({code:"custom",message:"Grounding provenance/method mismatch"});
  if (g.method === "xml_path" && !g.elementPath) ctx.addIssue({code:"custom",message:"XML evidence requires an element path"});
  for (const r of [...g.regions, ...g.contextRegions]) if (!g.frame || r.x+r.width>g.frame.width+0.01 || r.y+r.height>g.frame.height+0.01) ctx.addIssue({code:"custom",message:"Region outside source frame"});
  for (const r of g.regions) if (["page","table"].includes(r.granularity)) ctx.addIssue({code:"custom",message:"Coarse context cannot be precise evidence"});
  for (const r of g.regions) if (g.status === "derived" && (!r.tokenRefs.length || !["word","line"].includes(r.granularity))) ctx.addIssue({code:"custom",message:"Derived geometry must retain exact word references and word/line granularity"});
});
export const fieldEvidenceSchema = z.object({
  evidenceId: id, source: sourceBindingSchema, fieldPath: id,
  rawValue: z.string(), normalizedValue: z.union([z.string(), z.number().finite(), z.null()]),
  contentStatus: z.enum(["supported", "unresolved", "conflicting"]), quote: z.string(),
  grounding: groundingSchema,
});
export const sourceDocumentSchema = z.object({
  ...sourceBindingSchema.shape, deliveryId: id, name: id,
  kind: z.enum(["invoice", "purchase_order", "receipt", "contract", "credit_note", "correction", "other"]),
  mimeType: id, originalRef: id, byteLength: z.number().int().nonnegative(),
  originalBase64: z.string().optional(), extractedText: z.string(),
  provenance: z.object({ kind:z.enum(["synthetic", "external_private", "external_licensed"]), description:id, license:z.string(), originalFilename:id }),
  replaces: sourceBindingSchema.nullable(), pageCount: z.number().int().positive(),
  pageStatus: z.array(z.object({ page:z.number().int().positive(), status:z.enum(["complete","failed","missing"]), reason:z.string().nullable() })),
  parser: processorSchema.nullable(),
}).refine(s => s.pageStatus.length === s.pageCount && new Set(s.pageStatus.map(p=>p.page)).size === s.pageCount && s.pageStatus.every(p=>p.page<=s.pageCount), "Page status must cover exactly 1..pageCount");
export const quantitySchema = z.object({ decimal: z.string().regex(/^\d+(\.\d{1,6})?$/), unit: id });
export const allocationSchema = z.object({ account: id, amountCents: centsSchema, store: z.string().nullable(), department: z.string().nullable(), project: z.string().nullable(), period: z.string().regex(/^\d{4}-\d{2}$/), treatment: z.enum(["expense","inventory","fixed_asset","prepayment","tax"]) });
export const candidateLineSchema = z.object({
  lineId:id, sku:z.string().nullable(), description:id, quantity:quantitySchema,
  unitPriceCents:centsSchema, amountCents:centsSchema, taxCents:centsSchema,
  evidenceIds:z.array(id).min(1), poLineId:z.string().nullable(), receiptLineIds:z.array(id), allocations:z.array(allocationSchema),
});
export const candidateSchema = z.object({
  candidateId:id, revision:z.number().int().positive(), sources:z.array(sourceBindingSchema).min(1),
  extractedSupplierName:id, supplierId:z.string().nullable(), invoiceNumber:id,
  invoiceDate:date, dueDate:date.nullable(), terms:z.string().nullable(), currency:z.literal("USD"),
  kind:z.enum(["invoice","credit_note"]), appliesToBillId:z.string().nullable(),
  lines:z.array(candidateLineSchema).min(1), freightAllocations:z.array(allocationSchema), discountAllocations:z.array(allocationSchema), subtotalCents:centsSchema, taxCents:centsSchema,
  freightCents:centsSchema, discountCents:centsSchema, totalCents:centsSchema,
  evidence:z.array(fieldEvidenceSchema).min(1), parseWarnings:z.array(z.string()),
});
export const purchasingEvidenceSchema = z.object({
  supplierId:id, source:sourceBindingSchema, kind:z.enum(["purchase_order","receipt","contract","service_acceptance"]), reference:id,
  lines:z.array(z.object({lineId:id, sku:id, quantity:quantitySchema, unitPriceCents:centsSchema.nullable(), invoiceLineId:id})),
  acceptedBy:z.string().nullable(), acceptedAt:z.string().nullable(),
});
export const intakeSchema = z.object({
  contractVersion:z.literal(AP_CONTRACT_VERSION), idempotencyKey:id, documents:z.array(sourceDocumentSchema).min(1),
  candidate:candidateSchema.nullable(), extraction:z.object({status:z.enum(["complete","incomplete","failed"]), evidence:z.array(fieldEvidenceSchema), reasons:z.array(id)}), purchasingEvidence:z.array(purchasingEvidenceSchema),
  explicitRevisionOf:z.string().nullable(),
}).superRefine((input,ctx) => {
  const fail=(message:string)=>ctx.addIssue({code:"custom",message});
  if ((input.extraction.status === "complete") !== (input.candidate !== null)) fail("Complete extraction requires a candidate; incomplete extraction must not invent one");
  if (input.extraction.status !== "complete" && !input.extraction.reasons.length) fail("Incomplete extraction requires reasons");
  const key=(s:SourceBinding)=>`${s.sourceId}:${s.revision}:${s.sha256}`;
  const sources=new Map(input.documents.map(s=>[key(s),s]));
  if (sources.size !== input.documents.length) fail("Duplicate source binding");
  const candidateSources=new Set(input.candidate?.sources.map(key));
  for(const binding of input.candidate?.sources ?? []) if(!sources.has(key(binding))) fail("Candidate source is not an original document revision");
  const evidence=[...(input.candidate?.evidence ?? []),...input.extraction.evidence];
  for(const e of evidence) {
    const source=sources.get(key(e.source));
    if(!source || (input.candidate && !candidateSources.has(key(e.source)))) fail("Evidence source binding mismatch");
    if(e.grounding.page !== null && (!source || e.grounding.page>source.pageCount)) fail("Evidence page outside original source");
  }
  const ids=new Set(input.candidate?.evidence.map(e=>e.evidenceId));
  if(ids.size !== (input.candidate?.evidence.length ?? 0)) fail("Duplicate candidate evidence identity");
  for(const line of input.candidate?.lines ?? []) if(line.evidenceIds.some(e=>!ids.has(e))) fail("Line refers to missing evidence");
  if(input.candidate && input.documents.some(d=>d.pageStatus.some(p=>p.status!=="complete"))) fail("Complete candidate cannot omit failed or missing pages");
});
export const exceptionSchema = z.object({
  exceptionId:id, code:id, reason:id, ownerRole:z.enum(["ap_clerk","purchasing_owner","receiving_owner","controller","vendor_verification_owner"]),
  permittedActions:z.array(id), requiredEvidence:z.array(id), blocking:z.boolean(),
  status:z.enum(["open","resolved"]), resolution:z.object({actor:id, at:z.number(), reason:id, evidenceIds:z.array(id), policyVersion:id}).nullable(),
});
export const decisionSchema = z.object({
  decisionId:id, kind:z.enum(["field_review","bill_approval","exception_resolution","payment_authorization"]),
  actor:id, actorKind:z.enum(["human","agent"]), authority:id, at:z.number(),
  candidateRevision:z.number().int().positive(), sourceBindings:z.array(sourceBindingSchema), snapshotHash:hash,
  policyVersion:id, outcome:z.enum(["approved","rejected","needs_evidence"]), reason:id, evidenceIds:z.array(id),
});
export const amountsSchema = z.object({ invoicedCents:centsSchema.nullable(), acceptedCents:centsSchema.nullable(), disputedCents:centsSchema.nullable(), creditedCents:centsSchema, instructedCents:centsSchema, settledCents:centsSchema, outstandingCents:centsSchema.nullable() });
export const statesSchema = z.object({
  document:z.enum(["received","processing","review_required","reviewed","failed"]),
  business:z.enum(["unreviewed","held","approved","rejected"]),
  accounting:z.enum(["unposted","recognized","repair_required","corrected"]),
  authorization:z.enum(["not_requested","awaiting_approval","authorized","invalidated"]),
  execution:z.enum(["not_started","queued","in_flight","pending","unknown","settled","rejected","returned","cancelled","exception"]),
  reconciliation:z.enum(["unmatched","matched","exception"]),
});
export const caseDetailSchema = z.object({
  contractVersion:z.literal(AP_CONTRACT_VERSION), caseId:id, runId:id, organizationId:id,
  revision:z.number().int().positive(), candidate:candidateSchema.nullable(), extraction:z.object({status:z.enum(["complete","incomplete","failed"]), evidence:z.array(fieldEvidenceSchema), reasons:z.array(id)}), sources:z.array(sourceDocumentSchema),
  purchasingEvidence:z.array(purchasingEvidenceSchema), decisions:z.array(decisionSchema), exceptions:z.array(exceptionSchema),
  amounts:amountsSchema, states:statesSchema, policyVersion:id, snapshotHash:hash,
  scope:z.object({organizationId:id,runId:id,provider:z.enum(["fake","increase"]),environment:z.enum(["local","sandbox"]),accountId:id}),
  identityMode:z.enum(["simulated_human","authenticated_human"]),
  payments:z.array(z.object({versionId:id,commandId:z.string().nullable(),amountCents:centsSchema,status:id,beneficiaryVersion:id,providerTransferId:z.string().nullable(),authorizedBy:z.array(id)})),
  journals:z.array(z.object({entryId:id,kind:z.enum(["recognition","settlement","credit","return","correction"]),date:date,lines:z.array(z.object({account:id,debit:centsSchema,credit:centsSchema})),bankTransactionId:z.string().nullable()})),
  links:z.object({ billId:z.string().nullable(), billVersion:z.number().int().positive().nullable(), recognitionJournalId:z.string().nullable(), paymentVersionIds:z.array(id), commandIds:z.array(id), bankTransactionIds:z.array(id), settlementJournalIds:z.array(id), externalAccountingIds:z.array(id), duplicateOfCaseId:z.string().nullable() }),
  timeline:z.array(z.object({eventId:id, at:z.number(), actor:id, kind:id, summary:id, references:z.array(id)})),
  createdAt:z.number(), updatedAt:z.number(),
});
export const fixtureManifestSchema = z.object({
  contractVersion:z.literal(AP_CONTRACT_VERSION), fixtureId:id, version:id, provenance:z.literal("synthetic"),
  description:id, policyVersion:id, sources:z.array(sourceBindingSchema), inputFiles:z.array(id),
  expectedResultsFile:id, expectedResultsAccess:z.literal("evaluation_only_not_runtime"),
  review:z.object({status:z.enum(["policy_derived","agent_reviewed","practitioner_reviewed"]), reviewer:z.string().nullable(), reviewedAt:z.string().nullable(), evidenceRef:z.string().nullable()}),
});
export const expectedOutcomeSchema = z.object({
  fixtureId:id, policyVersion:id, fields:z.record(z.string(),z.union([z.string(),z.number(),z.null()])),
  expectedHoldCodes:z.array(id), expectedAcceptedCents:centsSchema.nullable(),
  recognition:z.array(z.object({account:id,debit:centsSchema,credit:centsSchema})),
  settlement:z.array(z.object({account:id,debit:centsSchema,credit:centsSchema})),
  expectedBillCount:z.number().int().nonnegative(), expectedTransferCount:z.number().int().nonnegative(),
  groundingExpectations:z.array(z.object({fieldPath:id,contentStatus:z.enum(["supported","unresolved","conflicting"]),allowedGeometry:z.array(z.enum(["native","derived","unresolved"]))})),
  reviewStatus:z.enum(["policy_derived","agent_reviewed","practitioner_reviewed"]),
});
export type SourceBinding = z.infer<typeof sourceBindingSchema>;
export type CoordinateFrame = z.infer<typeof frameSchema>;
export type EvidenceRegion = z.infer<typeof regionSchema>;
export type Processor = z.infer<typeof processorSchema>;
export type Grounding = z.infer<typeof groundingSchema>;
export type FieldEvidence = z.infer<typeof fieldEvidenceSchema>;
export type SourceDocument = z.infer<typeof sourceDocumentSchema>;
export type Candidate = z.infer<typeof candidateSchema>;
export type CandidateLine = z.infer<typeof candidateLineSchema>;
export type Allocation = z.infer<typeof allocationSchema>;
export type PurchasingEvidence = z.infer<typeof purchasingEvidenceSchema>;
export type APIntake = z.infer<typeof intakeSchema>;
export type APException = z.infer<typeof exceptionSchema>;
export type APDecision = z.infer<typeof decisionSchema>;
export type APCaseDetail = z.infer<typeof caseDetailSchema>;
export type FixtureManifest = z.infer<typeof fixtureManifestSchema>;
export type ExpectedOutcome = z.infer<typeof expectedOutcomeSchema>;
export const reviewRequestSchema = z.object({caseId:id, expectedRevision:z.number().int().positive(), sourceBindings:z.array(sourceBindingSchema).min(1), snapshotHash:hash, idempotencyKey:id, outcome:z.enum(["approved","rejected","needs_evidence"]), reason:id, evidenceIds:z.array(id)});
export const billApprovalRequestSchema = reviewRequestSchema.extend({acceptedCents:centsSchema});
export type ReviewRequest = z.infer<typeof reviewRequestSchema>;
export type BillApprovalRequest = z.infer<typeof billApprovalRequestSchema>;
