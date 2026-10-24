import type { CaseDetail, DecisionInput, SourceInput, WorkspaceSnapshot } from "../../src/invoice-mvp/contracts";

export class InvoiceApiError extends Error {
  constructor(message: string, public status: number, public code: string) { super(message); }
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/invoice-mvp${path}`, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "Content-Type": "application/json", "X-Invoice-MVP-Session": "1" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
  } catch {
    throw new InvoiceApiError("The invoice service could not be reached. Check the connection and retry. A submitted decision may already have been saved; retry the same decision to check safely.", 0, "connection");
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new InvoiceApiError(data?.error?.message ?? `The invoice service returned ${response.status}. Please retry.`, response.status, data?.error?.code ?? "service_error");
  if (data === null) throw new InvoiceApiError("The invoice service returned an unreadable response. Please retry.", 502, "invalid_response");
  return data as T;
}

export const invoiceApi = {
  workspace: () => request<WorkspaceSnapshot>("/workspace"),
  detail: (caseId: string) => request<CaseDetail>(`/cases/${encodeURIComponent(caseId)}`),
  demo: (late = false) => request<{ label: string; documents: SourceInput[] }>(`/demo-batch${late ? "?stage=late" : ""}`),
  import: (label: string, documents: SourceInput[], idempotencyKey: string) => request<{ batchId: string }>("/batches", { label, documents, idempotencyKey }),
  decide: (decision: DecisionInput) => request<unknown>("/decisions", decision),
  process: () => request<unknown>("/process", { maxCases: 20, live: false }),
};

export const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Something went wrong. Please retry.";

function asSource(value: unknown, index: number): SourceInput {
  const source = value as Partial<SourceInput> | null;
  if (!source || typeof source.externalId !== "string" || !source.externalId.trim() || typeof source.name !== "string" || typeof source.mimeType !== "string" || typeof source.text !== "string") {
    throw new Error(`Document ${index + 1} needs externalId, name, mimeType and extracted text.`);
  }
  if (source.contentBase64 !== undefined && typeof source.contentBase64 !== "string") throw new Error(`Document ${index + 1}: contentBase64 must be a string.`);
  if (source.replacesExternalId !== undefined && typeof source.replacesExternalId !== "string") throw new Error(`Document ${index + 1}: replacesExternalId must be a string.`);
  if (/pdf/i.test(source.mimeType) && (!source.contentBase64 || !source.text.trim())) throw new Error(`PDF “${source.name}” requires both original contentBase64 bytes and extracted text. PDF extraction is not available in this browser.`);
  if (source.contentBase64) {
    try { atob(source.contentBase64); } catch { throw new Error(`Document ${index + 1} has invalid base64 original bytes.`); }
  }
  return { externalId: source.externalId, name: source.name, mimeType: source.mimeType, text: source.text, contentBase64: source.contentBase64, replacesExternalId: source.replacesExternalId };
}

export async function readSourceFiles(files: File[]): Promise<SourceInput[]> {
  const documents: SourceInput[] = [];
  for (const file of files) {
    if (file.size > 2 * 1024 * 1024) throw new Error(`“${file.name}” exceeds the 2 MB per-file limit.`);
    if (!/\.(txt|csv|json)$/i.test(file.name)) throw new Error(`“${file.name}” is unsupported. Choose TXT, CSV or JSON. A PDF must be supplied in a JSON document bundle with original bytes and extracted text.`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (/\.json$/i.test(file.name)) {
      let data: unknown;
      try { data = JSON.parse(text); } catch { throw new Error(`“${file.name}” is not valid JSON.`); }
      const bundle = data && typeof data === "object" && "documents" in data ? (data as { documents: unknown }).documents : undefined;
      if (bundle !== undefined) {
        if (!Array.isArray(bundle) || !bundle.length) throw new Error(`“${file.name}” needs a nonempty documents array.`);
        documents.push(...bundle.map(asSource));
        continue;
      }
    }
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    documents.push({ externalId: file.name, name: file.name, mimeType: /\.json$/i.test(file.name) ? "application/json" : /\.csv$/i.test(file.name) ? "text/csv" : "text/plain", text, contentBase64: btoa(binary) });
  }
  if (!documents.length) throw new Error("Choose at least one document to import.");
  return documents;
}

export function downloadSource(source: SourceInput) {
  const contents = source.contentBase64 ? Uint8Array.from(atob(source.contentBase64), char => char.charCodeAt(0)) : source.text;
  // Always download inert bytes; never navigate to or execute supplied document content.
  const url = URL.createObjectURL(new Blob([contents], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = source.name.replace(/[\\/\u0000-\u001f]/g, "_") + (source.contentBase64 ? "" : ".extracted.txt");
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
