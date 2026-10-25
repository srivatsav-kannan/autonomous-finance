const GATEWAY = (import.meta.env.VITE_GATEWAY_URL as string | undefined) ?? "http://127.0.0.1:8787";
// Shared with the gateway through .env.local (`npm run gateway:token`). It proves a request
// came from this console; the human seat token itself stays on the gateway.
const TOKEN = import.meta.env.VITE_GATEWAY_TOKEN as string | undefined;

/** The human gateway holds the human seat token; the browser never sees it. */
export async function gateway(runId: string, pathname: string, init?: { method?: string; body?: unknown }) {
  if (!TOKEN) throw new Error("VITE_GATEWAY_TOKEN is not set. Run npm run gateway:token, then restart the console and gateway");
  const res = await fetch(`${GATEWAY}/runs/${encodeURIComponent(runId)}/${pathname}`, {
    method: init?.method ?? "GET",
    headers: { "content-type": "application/json", "x-gateway-token": TOKEN },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}
