const GATEWAY = (import.meta.env.VITE_GATEWAY_URL as string | undefined) ?? "http://127.0.0.1:8787";

/** The human gateway holds the human seat token; the browser never sees it. */
export async function gateway(runId: string, pathname: string, init?: { method?: string; body?: unknown }) {
  const res = await fetch(`${GATEWAY}/runs/${encodeURIComponent(runId)}/${pathname}`, {
    method: init?.method ?? "GET",
    headers: { "content-type": "application/json" },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}
