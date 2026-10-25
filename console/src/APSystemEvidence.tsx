import { useEffect, useMemo, useState } from "react";
import type { APCaseDetail, FieldEvidence } from "../../src/ap-system/contracts";
import { apError, downloadOriginal, loadPage } from "./apSystemApi";
import { apFieldLabel, apFieldValue, apLabel, displayedFrame, evidenceForCase, regionPolygon, sourceForEvidence } from "./apSystemView";

export function APSystemEvidence({ detail }: { detail: APCaseDetail }) {
  const fields = useMemo(() => evidenceForCase(detail), [detail]);
  const [selectedId, setSelectedId] = useState(fields[0]?.evidenceId ?? "");
  const [query, setQuery] = useState("");
  const selected = fields.find(e=>e.evidenceId===selectedId) ?? fields[0];
  const visibleFields = fields.filter(e=>`${apFieldLabel(e.fieldPath)} ${apFieldValue(e)} ${e.fieldPath}`.toLowerCase().includes(query.trim().toLowerCase()));
  const pageKey = selected ? `${detail.caseId}:${selected.source.sourceId}:${selected.source.revision}:${selected.source.sha256}:${selected.grounding.page}:${JSON.stringify(selected.grounding.frame)}` : "";
  return <div className="aps-evidence-grid">
    <div className="aps-field-list" aria-label="Extracted fields">
      <h3>Source fields</h3>
      <p className="aps-caption">{fields.length} fields. Select one to inspect its original evidence.</p>
      {fields.length === 0 ? <p className="aps-empty">No field evidence is available. The original files remain below.</p> : <>
        <label className="aps-field-search">Find a field<input type="search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="Name or value" /></label>
        <label className="aps-field-select">Selected field<select aria-label="Selected field" value={selected?.evidenceId} onChange={event=>setSelectedId(event.target.value)}>{fields.map(e=><option key={e.evidenceId} value={e.evidenceId}>{apFieldLabel(e.fieldPath)}: {apFieldValue(e)}</option>)}</select></label>
        <div className="aps-field-options" role="region" aria-label="Field search results" tabIndex={0}>
          {visibleFields.length === 0 ? <p className="aps-empty" role="status">No matching fields. Your selected source remains visible.</p> : visibleFields.map(e=><button key={e.evidenceId} type="button" aria-pressed={selected?.evidenceId===e.evidenceId} className={selected?.evidenceId===e.evidenceId ? "is-selected" : ""} onClick={()=>setSelectedId(e.evidenceId)}>
            <span>{apFieldLabel(e.fieldPath)}</span><strong>{apFieldValue(e)}</strong><small>{apLabel(e.contentStatus)} content <span className="aps-field-separator">/</span> {e.grounding.status === "unresolved" ? "Location unresolved" : `${apLabel(e.grounding.status)} location`}</small>
          </button>)}
        </div>
      </>}
    </div>
    <div className="aps-source-view">{selected ? <EvidencePage key={pageKey} detail={detail} evidence={selected} /> : <p className="aps-empty">A source citation will appear when fields are extracted.</p>}</div>
  </div>;
}
export function EvidencePage({ detail, evidence }: { detail: APCaseDetail; evidence: FieldEvidence }) {
  const source = sourceForEvidence(detail, evidence);
  const g = evidence.grounding;
  const [pageUrl,setPageUrl]=useState<string>();
  const [pageError,setPageError]=useState<string>();
  const [downloadError,setDownloadError]=useState<string>();
  const [downloading,setDownloading]=useState(false);
  const [imageReady,setImageReady]=useState(false);
  const frame=g.frame ? displayedFrame(g.frame) : null;
  const frameKey=JSON.stringify(g.frame);
  useEffect(()=>{
    if(!source || !g.page || !g.frame) return;
    const abort = new AbortController(); let url:string|undefined;
    loadPage(source,g.page,abort.signal).then(blob=>{ if(abort.signal.aborted)return;url=URL.createObjectURL(blob);setPageUrl(url); }).catch(error=>{if(!abort.signal.aborted)setPageError(apError(error));});
    return ()=>{abort.abort();if(url)URL.revokeObjectURL(url);};
  },[source?.sourceId,source?.revision,source?.sha256,g.page,frameKey]);
  const download=async()=>{if(!source)return;setDownloading(true);setDownloadError(undefined);try{await downloadOriginal(source);}catch(error){setDownloadError(apError(error));}finally{setDownloading(false);}};
  return <section aria-label="Selected source evidence">
    <div className="aps-section-heading"><div><h3>{source?.name ?? "Source version unavailable"}</h3><p className="aps-caption">{source ? `Revision ${source.revision}` : "Exact source binding is missing"}{g.page ? ` / Page ${g.page}` : ""}</p></div>{source && <button type="button" onClick={()=>void download()} disabled={downloading}>{downloading ? "Downloading…" : "Download original"}</button>}</div>
    <p className="aps-selected-field"><strong>{apFieldLabel(evidence.fieldPath)}</strong><span>{apFieldValue(evidence)}</span></p>
    <div className="aps-evidence-labels"><span className={`aps-status ${g.status}`}>{g.status === "unresolved" ? "Location unresolved" : `${apLabel(g.status)} location`}</span><span className={`aps-status ${evidence.contentStatus}`}>{apLabel(evidence.contentStatus)} content</span></div>
    {!source && <p className="aps-error" role="alert">This evidence belongs to a missing or different source revision. Highlights are hidden.</p>}
    {source && g.status === "unresolved" && <p className="aps-notice">{g.failureReason ?? "Precise geometry is unavailable."} {g.contextRegions.length ? "Only coarse context is shown." : "Review the original file and text citation."}</p>}
    {source && g.method === "xml_path" && <p className="aps-caption">XML element: <code>{g.elementPath}</code></p>}
    {source && g.frame && frame && g.page && <div className="aps-page-stage">
      {pageError ? <p className="aps-empty" role="status">{pageError}</p> : pageUrl ? <>
        <img className="aps-raster-check" src={pageUrl} alt="" onLoad={event=>{const image=event.currentTarget;const ratio=image.naturalWidth/image.naturalHeight; if(Math.abs(ratio-frame.width/frame.height) > 0.01){setPageError("The preview dimensions do not match the evidence frame. Highlights are hidden.");}else setImageReady(true);}} onError={()=>setPageError("The original page preview could not be displayed.")} />
        {imageReady ? <svg className="aps-page" viewBox={`${frame.x} ${frame.y} ${frame.width} ${frame.height}`} role="img" aria-label={`${source.name}, page ${g.page}, ${g.status} evidence regions`}>
          <image href={pageUrl} x={frame.x} y={frame.y} width={frame.width} height={frame.height} />
          {g.status !== "unresolved" ? g.regions.map((r,i)=><polygon key={i} className={`aps-region ${g.status}`} points={regionPolygon(g.frame!,r)} vectorEffect="non-scaling-stroke"><title>{`${apLabel(g.status)} ${r.granularity} ${i+1}`}</title></polygon>) : g.contextRegions.map((r,i)=><polygon key={i} className="aps-region context" points={regionPolygon(g.frame!,r)} vectorEffect="non-scaling-stroke"><title>Coarse context, not a field location</title></polygon>)}
        </svg> : <p className="aps-empty" role="status">Checking source page dimensions…</p>}
      </> : <p className="aps-empty" role="status">Loading the exact source page…</p>}
    </div>}
    <blockquote className="aps-quote">{evidence.quote || evidence.rawValue || "No readable text citation available."}</blockquote>
    {downloadError && <p className="aps-error" role="alert">{downloadError}</p>}
    <details className="aps-provenance"><summary>Evidence provenance</summary><dl className="aps-record">
      <div><dt>Field path</dt><dd><code>{evidence.fieldPath}</code></dd></div>
      <div><dt>Source hash</dt><dd><code>{evidence.source.sha256}</code></dd></div><div><dt>Source revision</dt><dd>{evidence.source.revision}</dd></div>
      <div><dt>Method</dt><dd>{apLabel(g.method)}</dd></div><div><dt>Processor</dt><dd>{g.processor.provider} {g.processor.version}</dd></div>
      <div><dt>Resolved version</dt><dd>{g.processor.resolvedVersion ?? "Not supplied by provider"}</dd></div><div><dt>Coordinates</dt><dd>{g.frame ? `${g.frame.width} × ${g.frame.height} ${g.frame.units}, ${g.frame.rotation}° orientation` : "No visual coordinates"}</dd></div>
      <div><dt>Normalization</dt><dd>{g.normalization}</dd></div><div><dt>Token references</dt><dd>{g.regions.flatMap(r=>r.tokenRefs).join(", ") || "None"}</dd></div>
      {g.processor.traineddata && <div><dt>OCR traineddata</dt><dd>{g.processor.traineddata.language} {g.processor.traineddata.version}<code>{g.processor.traineddata.sha256}</code></dd></div>}
    </dl></details>
  </section>;
}
