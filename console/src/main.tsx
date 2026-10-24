import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { App } from "./App";
import "./styles.css";

const convexUrl = import.meta.env.VITE_CONVEX_URL as string | undefined;
const convex = convexUrl ? new ConvexReactClient(convexUrl) : null;
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {convex ? <ConvexProvider client={convex}>
      <App />
    </ConvexProvider> : <main className="setup">
      <h1>Connect your finance backend</h1>
      <p>Start the local backend with <code>npm run backend</code>, then restart the console.</p>
      <p>The backend writes <code>VITE_CONVEX_URL</code> to <code>.env.local</code>. This connects the console to your scenarios.</p>
    </main>}
  </StrictMode>,
);
