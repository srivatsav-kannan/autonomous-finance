/** Explicit operator CLI. Input arrives through a private process environment, never JWT arguments. */
import path from "node:path";
import {
  bootstrapSandbox,
  BootstrapError,
} from "../../src/ap-system/sandbox-bootstrap";
const [mode, ...args] = process.argv.slice(2);
try {
  if (
    (mode !== "prepare" && mode !== "bind") ||
    (args.length !== 0 &&
      (args.length !== 2 || args[0] !== "--root" || !path.isAbsolute(args[1]!)))
  )
    throw new BootstrapError("bootstrap_arguments_invalid");
  const result = await bootstrapSandbox(
    mode,
    process.env,
    args[1] ?? process.cwd(),
  );
  console.log(JSON.stringify(result));
} catch (error) {
  // Backend, validation and filesystem messages may contain private values. Never forward them.
  console.error(
    JSON.stringify({
      stage: "stopped",
      code:
        error instanceof BootstrapError
          ? error.message
          : "bootstrap_failed_private_details_withheld",
    }),
  );
  process.exitCode = 1;
}
