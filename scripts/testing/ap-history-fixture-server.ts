import { createServer } from "vite";
import { fileURLToPath } from "node:url";

export async function startHistoryFixtureServer(port = 0) {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const server = await createServer({
    configFile: false,
    envFile: false,
    root,
    logLevel: "error",
    server: { host: "127.0.0.1", port, strictPort: true },
    // Bundle every dependency of the fixture page at startup. If Vite discovers one
    // on first page load (pdfjs-dist, for example), it reloads the page mid-test.
    optimizeDeps: { entries: ["tests/ap-system/agent-history.browser.fixture.tsx"] },
    plugins: [
      {
        name: "stored-ap-history-fixture",
        configureServer(s) {
          s.middlewares.use("/ap-system", (_q, r) => {
            r.setHeader("Content-Type", "text/html");
            r.end(
              '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Stored AP history fixtures</title></head><body><div id="root"></div><script type="module" src="/tests/ap-system/agent-history.browser.fixture.tsx"></script></body></html>',
            );
          });
        },
      },
    ],
  });
  await server.listen();
  return { server, url: server.resolvedUrls!.local[0]! };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { server, url } = await startHistoryFixtureServer(
    Number(process.env.AP_HISTORY_PORT ?? 5197),
  );
  console.log(
    `Stored fixture viewer (no backend): ${url}ap-system?fixture=missing-receipt`,
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, async () => {
      await server.close();
      process.exit(0);
    });
}
