import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { App } from "./App";
import "./styles.css";

const convexUrl = import.meta.env.VITE_CONVEX_URL as string | undefined;
const convex = convexUrl ? new ConvexReactClient(convexUrl) : undefined;
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {convex ? <ConvexProvider client={convex}><App /></ConvexProvider> : <App hasSimulation={false} />}
  </StrictMode>,
);
