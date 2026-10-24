import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "console",
  envDir: "..",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api/invoice-mvp": { target: "http://127.0.0.1:8790", changeOrigin: false },
    },
  },
});
