import { useEffect, useRef, useState } from "react";
import type { ApexProcessingJob } from "./apexDisplayTypes";
import { apProtectedFetch } from "./apAuthSession";
import { apError } from "./apSystemApi";
import { apLabel } from "./apSystemView";
import "./apProcessingRun.css";

type Props = {
  onChanged: () => void;
  onOpenCase: (caseId: string) => void;
  onBusy: (busy: boolean) => void;
};

async function processingRequest(signal: AbortSignal, idempotencyKey?: string): Promise<ApexProcessingJob | null> {
  const { response, assertCurrent } = await apProtectedFetch("/api/ap-system/demo/process", {
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    method: idempotencyKey ? "POST" : "GET",
    ...(idempotencyKey ? {
      headers: { "Content-Type": "application/json", "X-AP-System-Session": "1" },
      body: JSON.stringify({ idempotencyKey }),
    } : {}),
  });
  const result = await response.json().catch(() => { throw new Error("The processing service returned an unreadable status. Refresh to check the actual outcome."); });
  assertCurrent();
  if (!response.ok) throw new Error(result?.error?.reason ?? `Document processing is unavailable (${response.status}).`);
  if (idempotencyKey && result === null) throw new Error("Processing has not started. Refresh its status before retrying.");
  if (result !== null && (!Array.isArray(result.steps) || !result.counts || !["running", "complete", "failed", "interrupted"].includes(result.status))) {
    throw new Error("The processing service returned an unreadable status. Refresh to check the actual outcome.");
  }
  return result;
}

export function APProcessingRun({ onChanged, onOpenCase, onBusy }: Props) {
  const [job, setJob] = useState<ApexProcessingJob | null>();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const callbacks = useRef({ onChanged, onOpenCase, onBusy });
  callbacks.current = { onChanged, onOpenCase, onBusy };
  const completedSignature = useRef<string | null>(null);
  const jobRunning = useRef(false);
  const requestKey = useRef<string | undefined>(undefined);
  const startRequest = useRef<AbortController | null>(null);
  const running = job?.status === "running";

  function accept(next: ApexProcessingJob | null) {
    setJob(next);
    jobRunning.current = next?.status === "running";
    const completed = next?.steps.filter(step => step.status === "complete" && step.caseId).map(step => `${step.sha256}:${step.caseId}`).join("|") ?? "";
    const signature = completed ? `${next!.id}:${completed}` : "";
    if (signature && completedSignature.current !== null && completedSignature.current !== signature) callbacks.current.onChanged();
    completedSignature.current = signature;
  }

  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = jobRunning.current;
    async function poll() {
      try {
        const next = await processingRequest(abort.signal);
        if (abort.signal.aborted) return;
        accept(next);
        setError(undefined);
        active = next?.status === "running";
      } catch (failure) {
        if (abort.signal.aborted) return;
        setError(apError(failure));
      }
      // Poll real server state. No timer advances document stages or counts.
      if (active && !abort.signal.aborted) timer = setTimeout(poll, 1000);
    }
    void poll();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [refresh]);

  useEffect(() => {
    callbacks.current.onBusy(starting || running);
  }, [starting, running]);
  useEffect(() => () => {
    startRequest.current?.abort();
    callbacks.current.onBusy(false);
  }, []);

  async function start() {
    if (startRequest.current || running) return;
    const abort = new AbortController();
    startRequest.current = abort;
    requestKey.current ??= crypto.randomUUID();
    setStarting(true); setError(undefined);
    try {
      const next = await processingRequest(abort.signal, requestKey.current);
      if (abort.signal.aborted) return;
      accept(next);
      setRefresh(value => value + 1);
    } catch (failure) {
      if (!abort.signal.aborted) setError(apError(failure));
    } finally {
      startRequest.current = null;
      if (!abort.signal.aborted) setStarting(false);
    }
  }

  const complete = job?.status === "complete";
  const activeStep = job?.steps.find(step => step.status === "parsing" || step.status === "importing");
  const label = starting ? "Starting document processing…" : running ? "Processing originals…" : complete ? "All originals processed" : job ? "Retry unfinished documents" : "Process invoice PDFs";
  return <section className="aps-processing" aria-label="Live APEX document processing">
    <div className="aps-processing-heading">
      <div><h3>Process the original invoices</h3><p>Run PDF extraction, supplier matching and control checks on every available APEX invoice.</p></div>
      <button className="primary" type="button" disabled={starting || running || complete || job === undefined} onClick={() => void start()}>{label}</button>
    </div>
    {job === undefined && !error && <p role="status">Connecting to the document processor…</p>}
    {error && <p className="aps-error" role="alert">{error} <button type="button" onClick={() => setRefresh(value => value + 1)} disabled={starting}>Refresh processing status</button></p>}
    {job && <>
      <div className="aps-processing-progress">
        <p role="status" aria-live="polite"><strong>{job.counts.complete} of {job.counts.total} processed</strong>{job.counts.failed > 0 && <span> / {job.counts.failed} need a retry</span>}{activeStep && <span> / {activeStep.file}: {activeStep.status === "parsing" ? "reading PDF text and citations" : "saving the case and checking controls"}</span>}{job.status === "interrupted" && <span> / Processing was interrupted. Resume the unfinished originals.</span>}</p>
        <progress aria-label="Original documents processed" value={job.counts.complete + job.counts.failed} max={Math.max(job.counts.total, 1)}/>
      </div>
      {job.error && <p className="aps-error" role="alert">{job.error}</p>}
      <ol className="aps-processing-rows" aria-label="Processing results for each original">
        {job.steps.map(step => <li key={step.sha256} data-status={step.status}>
          <div className="aps-processing-document"><strong>{step.invoiceNumber ?? step.file}</strong><span>{step.invoiceNumber ? step.file : "Original PDF"}</span></div>
          <div className="aps-processing-result"><span>{step.status === "queued" ? "Waiting to process" : step.status === "parsing" ? "Parsing original PDF" : step.status === "importing" ? "Creating case and checking controls" : step.status === "failed" ? "Processing failed" : step.extractionStatus !== "complete" ? "Extraction needs review" : step.disposition === "existing" ? "Existing case retained" : "Case created"}</span>
            {step.parser && <small>Parser: {step.parser}</small>}
            {step.exceptions.length > 0 && <details><summary>{step.exceptions.length} control {step.exceptions.length === 1 ? "issue" : "issues"}</summary><ul>{step.exceptions.map((issue, index) => <li key={`${issue}:${index}`}>{apLabel(issue)}</li>)}</ul></details>}
            {step.error && <small className="aps-error">{step.error}</small>}
          </div>
          {step.status === "complete" && step.caseId && <button type="button" onClick={() => callbacks.current.onOpenCase(step.caseId!)}>Inspect original & fields</button>}
        </li>)}
      </ol>
    </>}
    <p className="aps-caption">Progress comes from the running processor. Existing originals keep their cases. Holds stay in place; processing does not approve invoices or send payments.</p>
  </section>;
}
