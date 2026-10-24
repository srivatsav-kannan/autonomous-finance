import { createServiceFromEnv } from "../src/invoice-mvp/service";
import { createInvoiceServer } from "../src/invoice-mvp/server";

try {
  const port = Number(process.env.INVOICE_MVP_PORT ?? 8790);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid INVOICE_MVP_PORT");
  const allowedOrigins = process.env.INVOICE_MVP_ALLOWED_ORIGINS?.split(",").map((o) => o.trim()).filter(Boolean);
  const service = createServiceFromEnv();
  const server = createInvoiceServer(service, { port, allowedOrigins });
  server.listen(port, "127.0.0.1", () => console.log(`Invoice MVP gateway http://127.0.0.1:${port} (${service.mode}; simulated human identity; live evaluation NOT RUN)`));
  const stop = () => { server.close(); server.closeIdleConnections(); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Invoice gateway could not start.");
  process.exitCode = 1;
}
