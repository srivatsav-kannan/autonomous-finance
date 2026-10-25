import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "console",
  envDir: "..",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5192,
    strictPort: true,
    proxy: {
      "/api/apex": { target: "http://127.0.0.1:8847", changeOrigin: false, rewrite: path => path.replace(/^\/api\/apex/, "/api/ap-system"), cookiePathRewrite: "/api/apex" },
      "/api/ap-system": { target: process.env.AP_SYSTEM_GATEWAY_URL ?? "http://127.0.0.1:8823", changeOrigin: false },
      "/api/invoice-mvp": { target: process.env.INVOICE_MVP_GATEWAY_URL ?? "http://127.0.0.1:8790", changeOrigin: false },
    },
  },
});
