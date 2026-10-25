import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { App } from "./App";
import { APDemo } from "./APDemo";
import "./styles.css";

const isAPDemo = location.pathname.replace(/\/$/, "") === "/ap-demo";
const convexUrl = import.meta.env.VITE_CONVEX_URL as string | undefined;
const convex = !isAPDemo && convexUrl ? new ConvexReactClient(convexUrl) : undefined;
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isAPDemo ? <APDemo /> : convex ? <ConvexProvider client={convex}><App /></ConvexProvider> : <App hasSimulation={false} />}
  </StrictMode>,
);
