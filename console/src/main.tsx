import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { App } from "./App";
import { APDemo } from "./APDemo";
import "./styles.css";

const isAPDemo = location.pathname.replace(/\/$/, "") === "/ap-demo";
const convex = isAPDemo ? null : new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isAPDemo ? <APDemo /> : <ConvexProvider client={convex!}><App /></ConvexProvider>}
  </StrictMode>,
);
