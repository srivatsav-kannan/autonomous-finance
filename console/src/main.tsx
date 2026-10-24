import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { lazy, Suspense } from "react";
import { InvoiceWorkspace } from "./InvoiceWorkspace";

const LegacyApp = lazy(async () => {
  await import("./styles.css");
  const { App } = await import("./App");
  return { default: App };
});
const isLegacy = location.pathname === "/legacy" || location.pathname.startsWith("/legacy/");
const convexUrl = import.meta.env.VITE_CONVEX_URL as string | undefined;
const convex = isLegacy && convexUrl ? new ConvexReactClient(convexUrl) : undefined;
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isLegacy ? convex ? <ConvexProvider client={convex}><Suspense fallback={<p>Loading legacy console…</p>}><LegacyApp /></Suspense></ConvexProvider> : <p>The legacy console needs VITE_CONVEX_URL. <a href="/invoices">Open invoice workspace</a></p> : <InvoiceWorkspace />}
  </StrictMode>,
);
