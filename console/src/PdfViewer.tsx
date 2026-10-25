import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { Icon } from "./Icon";
import "./pdfViewer.css";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

function PdfPage({ document, number, scale, width }: { document: PDFDocumentProxy; number: number; scale: number; width: number }) {
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => { if (entry?.isIntersecting) setVisible(true); }, { rootMargin: "800px" });
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || !host.current) return;
    let disposed = false;
    let render: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]> | undefined;
    const container = host.current;
    // Give every render its own canvas: cancelled tasks must never reuse an active canvas.
    const canvas = window.document.createElement("canvas");
    canvas.setAttribute("aria-label", `PDF page ${number}`);
    container.replaceChildren(canvas);
    setError("");
    void document.getPage(number).then(async (page) => {
      if (disposed) return;
      const original = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.max(160, width - 40) / original.width * scale });
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      render = page.render({ canvas, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
      await render.promise;
    }).catch((e: Error) => { if (!disposed && e.name !== "RenderingCancelledException") setError(e.message); });
    return () => { disposed = true; render?.cancel(); canvas.remove(); };
  }, [document, number, scale, width, visible]);
  return <section className="pdf-page" data-page={number} aria-label={`Page ${number}`}><div ref={host} className="pdf-canvas" />{error && <p role="alert">Page could not render: {error}</p>}<p className="pdf-page-number">Page {number}</p></section>;
}

export default function PdfViewer({ url, name }: { url: string; name: string }) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState("");
  const [scale, setScale] = useState(1);
  const [page, setPage] = useState(1);
  const [width, setWidth] = useState(600);
  const [expanded, setExpanded] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let disposed = false;
    let task: ReturnType<typeof import("pdfjs-dist")["getDocument"]> | undefined;
    setDocument(null); setError(""); setPage(1); setScale(1);
    void import("pdfjs-dist").then(async (pdfjs) => {
      if (disposed) return;
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      task = pdfjs.getDocument({ url });
      const loaded = await task.promise;
      if (!disposed) setDocument(loaded);
    }).catch((e: Error) => { if (!disposed) setError(e.message); });
    return () => { disposed = true; void task?.destroy(); };
  }, [url]);
  useEffect(() => {
    const host = scroll.current;
    if (!host) return;
    const observer = new ResizeObserver(([entry]) => { if (entry) setWidth(entry.contentRect.width); });
    observer.observe(host);
    return () => observer.disconnect();
  }, [expanded]);
  const goTo = (value: number) => {
    const next = Math.max(1, Math.min(document?.numPages ?? 1, Math.round(value) || 1));
    setPage(next);
    const target = scroll.current?.querySelector<HTMLElement>(`[data-page="${next}"]`);
    if (target && scroll.current) scroll.current.scrollTop += target.getBoundingClientRect().top - scroll.current.getBoundingClientRect().top - 16;
  };
  useEffect(() => {
    if (expanded && dialog.current && !dialog.current.open) dialog.current.showModal();
    const frame = requestAnimationFrame(() => goTo(page));
    return () => cancelAnimationFrame(frame);
  }, [expanded]);
  const closeExpanded = () => {
    setExpanded(false);
    requestAnimationFrame(() => expandButton.current?.focus());
  };
  const content = <>
    <div className="pdf-toolbar" aria-label="PDF controls">
      <span className="pdf-filename" title={name}>{name}</span>
      <div className="pdf-control-group" role="group" aria-label="Page navigation">
        <button type="button" className="pdf-previous" aria-label="Previous PDF page" disabled={!document || page <= 1} onClick={() => goTo(page - 1)}><Icon name="chevron" /></button>
        <label>Page <input aria-label="PDF page" type="number" min={1} step={1} max={document?.numPages ?? 1} value={page} disabled={!document} onChange={(e) => goTo(Number(e.target.value))} /></label><span>of {document?.numPages ?? "—"}</span>
        <button type="button" aria-label="Next PDF page" disabled={!document || page >= document.numPages} onClick={() => goTo(page + 1)}><Icon name="chevron" /></button>
      </div>
      <div className="pdf-control-group" role="group" aria-label="Zoom controls">
        <button type="button" aria-label="Zoom out" disabled={!document || scale <= .5} onClick={() => setScale((s) => Math.max(.5, s - .25))}>−</button>
        <output aria-label="PDF zoom">{Math.round(scale * 100)}%</output>
        <button type="button" aria-label="Zoom in" disabled={!document || scale >= 3} onClick={() => setScale((s) => Math.min(3, s + .25))}>+</button>
        <button type="button" disabled={!document} onClick={() => setScale(1)} aria-label="Fit PDF to width">Fit width</button>
      </div>
      <div className="pdf-control-group pdf-file-actions">
        <a href={url} download={name}>Download</a>
        {expanded ? <button type="button" onClick={() => dialog.current?.close()}>Close expanded PDF</button> : <button ref={expandButton} type="button" disabled={!document} onClick={() => setExpanded(true)}>Expand PDF</button>}
      </div>
    </div>
    <div className="pdf-scroll" ref={scroll} tabIndex={0} role="region" aria-label="Scrollable PDF document" onScroll={() => {
      const host = scroll.current;
      if (!host) return;
      const top = host.getBoundingClientRect().top;
      const current = [...host.querySelectorAll<HTMLElement>("[data-page]")].find((el) => el.getBoundingClientRect().bottom > top + 60);
      if (current) setPage(Number(current.dataset.page));
    }}>
      {error ? <p className="feedback error" role="alert">Unable to open PDF: {error}. Download the original or retry opening this case.</p> : document ? Array.from({ length: document.numPages }, (_, i) => <PdfPage key={i} document={document} number={i + 1} scale={scale} width={width} />) : <p className="loading" role="status">Loading PDF…</p>}
    </div>
  </>;
  return <div className="pdf-viewer">
    {!expanded && content}
    <dialog ref={dialog} className="pdf-dialog" aria-label={`Expanded PDF: ${name}`} onClose={closeExpanded}>
      {expanded && content}
    </dialog>
  </div>;
}
