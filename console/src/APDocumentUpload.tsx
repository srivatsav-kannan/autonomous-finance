import { useEffect, useRef, useState, type FormEvent } from "react";
import type { SourceDocument } from "../../src/ap-system/contracts";
import { apError, apSystemApi } from "./apSystemApi";
import { apLabel } from "./apSystemView";
import { apProtectedFetch } from "./apAuthSession";

type Entry = { file: File; kind: SourceDocument["kind"]; key: string; caseId?: string; error?: string };
export function APDocumentUpload({ sessionReady, onBusy, onComplete, onImported }: { sessionReady: boolean; onBusy: (value: boolean) => void; onComplete: (caseId: string) => void; onImported?: () => void }) {
  const [files, setFiles] = useState<Entry[]>([]);
  const [mode, setMode] = useState<"invoices" | "packet">("invoices");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string>();
  const [progress, setProgress] = useState("");
  const packetKey = useRef<string | undefined>(undefined);
  const [tracksProgress, setTracksProgress] = useState(false);
  const [activeRequest, setActiveRequest] = useState<string>();
  const [serverProgress, setServerProgress] = useState<string>();
  useEffect(() => {
    const abort = new AbortController();
    void fetch("/api/ap-system/runtime", {signal:abort.signal,credentials:"same-origin"})
      .then(response => response.ok ? response.json() : null)
      .then(runtime => {if(!abort.signal.aborted)setTracksProgress(runtime?.intakeProgress === true);})
      .catch(() => {});
    return () => abort.abort();
  }, []);
  useEffect(() => {
    if(!tracksProgress || !activeRequest)return;
    const abort = new AbortController();let timer:ReturnType<typeof setTimeout>;
    setServerProgress("Uploading the originals to the authenticated AP service…");
    const poll = async () => {
      try {
        const {response,assertCurrent}=await apProtectedFetch(`/api/ap-system/intake-status/${encodeURIComponent(activeRequest)}`, {signal:AbortSignal.any([abort.signal,AbortSignal.timeout(10000)])});
        const status=await response.json();assertCurrent();
        if(!abort.signal.aborted && response.ok && status){
          const labels:Record<string,string>={parsing:"The AP service is parsing the original documents. Waiting for its extraction result…",ingesting:"Extraction returned. Saving source evidence and checking the AP case…",complete:"Case saved. Inspect the source fields and any extraction or policy issues.",failed:"Processing stopped. The service retained the error for review."};
          if(labels[status.status])setServerProgress(labels[status.status]);
        }
      }catch{if(!abort.signal.aborted)setServerProgress("Reconnecting to processing status. The original request may still be running…");}
      if(!abort.signal.aborted)timer=setTimeout(poll,1000);
    };
    void poll();
    return()=>{abort.abort();clearTimeout(timer);};
  },[tracksProgress,activeRequest]);
  const intake = async (documents: {file:File;kind:SourceDocument["kind"]}[], key:string) => {
    setActiveRequest(key);setServerProgress(undefined);
    try{return await apSystemApi.intake(documents,key);}
    finally{setActiveRequest(undefined);}
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(undefined);
    if (!sessionReady) { setError("Restore the workspace connection before uploading documents."); return; }
    if (!files.length) return;
    const limit = 8 * 1024 * 1024;
    if (files.some(({file}) => file.size > limit) || mode === "packet" && (files.length > 10 || files.reduce((n, {file}) => n + file.size, 0) > limit)) {
      setError("Each invoice can be up to 8 MiB. A supporting packet can contain up to 10 files and 8 MiB total."); return;
    }
    if (mode === "packet" && files.filter(file => file.kind === "invoice").length !== 1) { setError("A supporting packet needs exactly one invoice. Set the other document kinds below."); return; }
    onBusy(true); setUploading(true);
    try {
      if (mode === "packet") {
        packetKey.current ??= crypto.randomUUID();
        const result = await intake(files, packetKey.current);
        onComplete(result.caseId);
      } else {
        for (const [index, entry] of files.entries()) {
          if (entry.caseId) continue;
          setProgress(`Parsing invoice ${index + 1} of ${files.length}: ${entry.file.name}`);
          try {
            const result = await intake([{file:entry.file, kind:"invoice"}], entry.key);
            setFiles(current => current.map(file => file.key === entry.key ? {...file, caseId:result.caseId, error:undefined} : file));
            if (files.length === 1) onComplete(result.caseId);
          } catch (failure) {
            setFiles(current => current.map(file => file.key === entry.key ? {...file, error:apError(failure)} : file));
          }
        }
        onImported?.();
        setProgress("Import finished. Open a case to review its extraction and any holds. Existing invoices retain their case.");
      }
    } catch (failure) { setError(apError(failure)); }
    finally { setUploading(false); onBusy(false); }
  };
  const pending = files.filter(file => !file.caseId).length;
  return <form className="aps-upload" onSubmit={submit}>
    <h3>Import original documents</h3>
    <p>Import invoices separately, or group one invoice with its supporting evidence.</p>
    <label>Import as<select aria-label="Import mode" value={mode} disabled={uploading} onChange={event => {setMode(event.target.value as typeof mode); packetKey.current=undefined; setFiles(current => current.map(file => ({...file, caseId:undefined,error:undefined})));}}><option value="invoices">Separate invoice cases</option><option value="packet">One invoice with supporting documents</option></select></label>
    <label htmlFor="ap-source-files">Original documents</label>
    <input id="ap-source-files" type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff,.xml" disabled={uploading} onChange={event => {packetKey.current=undefined; setError(undefined); setProgress(""); setFiles(Array.from(event.target.files ?? []).map(file => ({file, kind:"invoice", key:crypto.randomUUID()})));}}/>
    {files.length > 0 && <ul className="aps-import-files">{files.map(entry => <li key={entry.key}><span>{entry.file.name}</span>{mode === "packet" && <label>Document kind<select aria-label={`Kind of ${entry.file.name}`} value={entry.kind} disabled={uploading} onChange={event => {packetKey.current=undefined;setFiles(current => current.map(file => file.key === entry.key ? {...file,kind:event.target.value as SourceDocument["kind"]} : file));}}>{["invoice","purchase_order","receipt","contract","credit_note","correction","other"].map(kind => <option key={kind} value={kind}>{apLabel(kind)}</option>)}</select></label>}{entry.caseId && <button type="button" disabled={uploading} onClick={() => onComplete(entry.caseId!)}>Open imported case</button>}{entry.error && <p role="alert" className="aps-error">{entry.error}</p>}</li>)}</ul>}
    {progress && <p role="status">{progress}</p>}{activeRequest&&serverProgress&&<p role="status" aria-live="polite">{serverProgress}</p>}{error && <p role="alert" className="aps-error">{error}</p>}
    {!sessionReady && <p role="status">Waiting for the workspace connection before upload.</p>}
    <button type="submit" className="primary" disabled={uploading || !sessionReady || !files.length || mode === "invoices" && !pending}>{uploading ? "Preserving and parsing originals…" : mode === "packet" ? "Import source packet" : files.some(file => file.error) ? "Retry remaining invoices" : "Parse invoices"}</button>
    <small>Each separate invoice: up to 8 MiB. Supporting packet: up to 10 files and 8 MiB total. Parsing never approves a bill or releases a payment.</small>
  </form>;
}
