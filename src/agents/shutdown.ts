/** Stop scheduling immediately; allow current handlers at most 30 seconds to finish. */
export function installShutdown(team: { stop(): void }, graceMs = 30_000): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopping = false;
  const stop = (signal: "SIGINT" | "SIGTERM") => {
    team.stop();
    const code = signal === "SIGINT" ? 130 : 143;
    process.exitCode = code;
    if (stopping) process.exit(code);
    stopping = true;
    console.error(`agent-worker: ${signal}; stopping claims, shutdown grace ${graceMs}ms`);
    timer = setTimeout(() => process.exit(code), graceMs);
    timer.unref();
  };
  const interrupt = () => stop("SIGINT");
  const terminate = () => stop("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  return () => {
    clearTimeout(timer);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  };
}
