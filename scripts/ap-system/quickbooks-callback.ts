import { resolve } from "node:path";
import { callbackServer } from "../../src/ap-system/quickbooks/callback";
import { OAuth, configFromEnv } from "../../src/ap-system/quickbooks/oauth";
import {
  PrivateStore,
  safeError,
} from "../../src/ap-system/quickbooks/private-store";
try {
  const store = new PrivateStore(
    resolve(process.env.QBO_PRIVATE_DIR ?? "var/quickbooks-private"),
  );
  await store.init();
  const server = callbackServer(new OAuth(configFromEnv(), store));
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  server.on("error", () => {
    console.error("qbo_callback_listen_failed");
    process.exitCode = 1;
  });
  server.listen(8824, "127.0.0.1", () =>
    console.log(
      "Open http://localhost:8824/ to connect the configured US sandbox. No credentials are printed.",
    ),
  );
} catch (e) {
  console.error(safeError(e));
  process.exitCode = 1;
}
