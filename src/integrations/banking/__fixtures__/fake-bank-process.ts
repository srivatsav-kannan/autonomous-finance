import { openFakeBank } from "../fake.js";
import type { BankCommand } from "../../contracts.js";
const [path, encodedCommand, mode] = process.argv.slice(2);
if (!path || !encodedCommand) throw new Error("Usage: fake-bank-process PATH BASE64_COMMAND [crash]");
const command = JSON.parse(Buffer.from(encodedCommand, "base64").toString("utf8")) as BankCommand;
const bank = openFakeBank({ path, scope: command.scope, seed: 7 });
try {
  const transfer = await bank.provider.createTransfer(command);
  if (mode === "crash") process.exit(23);
  process.stdout.write(JSON.stringify({ transferId: transfer.id }));
  bank.close();
} catch (error) {
  if (mode === "crash") process.exit(23);
  bank.close();
  throw error;
}
