import { useState } from "react";
import { Icon } from "./Icon";
import { gateway } from "./gateway";

export function EvidenceRecord({
  runId,
  reference,
  label,
}: {
  runId: string;
  reference: string;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const readable = reference.startsWith("decisions/");
  const read = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (text !== null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await gateway(
        runId,
        `memory/show?path=${encodeURIComponent(reference)}`,
      );
      setText(result.text ?? "This record is not on the main branch.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="evidence-record">
      {readable ? (
        <button
          type="button"
          className="evidence-button"
          onClick={() => void read()}
          aria-expanded={open}
          aria-busy={busy}
        >
          <Icon name="file" />
          <span>
            <strong>{label}</strong>
            <span>{reference}</span>
          </span>
          <Icon name="chevron" />
        </button>
      ) : (
        <div className="evidence-reference">
          <Icon name="file" />
          <span>
            <strong>{label}</strong>
            <span>{reference}</span>
          </span>
        </div>
      )}
      {open && (
        <div className="evidence-content">
          {busy ? (
            <div className="loading" role="status">
              Loading source record…
              <span className="loading-bar" />
              <span className="loading-bar" />
            </div>
          ) : error ? (
            <p className="feedback error" role="alert">
              {error}. Close and reopen the record to retry.
            </p>
          ) : (
            <pre className="file">{text}</pre>
          )}
        </div>
      )}
    </div>
  );
}
