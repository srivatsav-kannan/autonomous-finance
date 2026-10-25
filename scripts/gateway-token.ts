// Write a fresh human-gateway token to .env.local, keeping every other setting as it is.
// The console (Vite) and the gateway both read VITE_GATEWAY_TOKEN from that file.
//   npm run gateway:token      (then restart `npm run gateway` and `npm run console`)
import { randomBytes } from "node:crypto";
import fs from "node:fs";

const file = ".env.local";
const line = `VITE_GATEWAY_TOKEN=${randomBytes(32).toString("hex")}`;
const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
const kept = existing.split("\n").filter((l) => !/^\s*VITE_GATEWAY_TOKEN\s*=/.test(l));
while (kept.length && kept[kept.length - 1] === "") kept.pop();
fs.writeFileSync(file, `${[...kept, line].join("\n")}\n`, { mode: 0o600 });
console.log(`${existing ? "Updated" : "Created"} ${file} with a new VITE_GATEWAY_TOKEN. Restart the gateway and console to use it.`);
