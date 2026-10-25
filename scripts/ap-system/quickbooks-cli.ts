import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { OAuth, configFromEnv } from "../../src/ap-system/quickbooks/oauth";
import {
  PrivateStore,
  QboError,
  safeError,
} from "../../src/ap-system/quickbooks/private-store";
import { QboClient } from "../../src/ap-system/quickbooks/client";
import {
  QuickBooksDispatcher,
  SyncJournal,
} from "../../src/ap-system/quickbooks/sync";
import {
  billPlan,
  validateMappings,
} from "../../src/ap-system/quickbooks/plans";
import type {
  AccountingExport,
  Mappings,
  ExportRequest,
} from "../../src/ap-system/quickbooks/types";
const [command, ...rest] = process.argv.slice(2);
const option = (key: string) => {
  const n = rest.indexOf(key);
  return n < 0 ? undefined : rest[n + 1];
};
const json = async (path: string | undefined) => {
  if (!path) throw new QboError("input_path_required");
  const raw = await readFile(path);
  if (raw.length > 4 * 1024 * 1024) throw new QboError("input_too_large");
  return JSON.parse(raw.toString());
};
try {
  if (
    !["dry-run", "inspect", "mapping-check", "submit", "verify"].includes(
      command ?? "",
    )
  )
    throw new QboError(
      "usage_quickbooks_cli_dry-run_inspect_mapping-check_submit_verify",
    );
  if (command === "dry-run") {
    const mappings = (await json(option("--mappings"))) as Mappings;
    validateMappings(mappings, mappings.realmId);
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          externalWrites: 0,
          plan: billPlan(
            (await json(option("--input"))) as AccountingExport,
            mappings,
          ),
        },
        null,
        2,
      ),
    );
  } else {
    if (option("--input"))
      throw new QboError("external_write_requires_authenticated_backend");
    const config = configFromEnv();
    const store = new PrivateStore(
      resolve(process.env.QBO_PRIVATE_DIR ?? "var/quickbooks-private"),
    );
    const client = new QboClient(new OAuth(config, store));
    if (command === "inspect") {
      const company = await client.get("CompanyInfo", config.realmId);
      const accounts = await client.request(
        "query",
        "GET",
        undefined,
        undefined,
        "SELECT * FROM Account MAXRESULTS 1000",
      );
      const vendors = await client.request(
        "query",
        "GET",
        undefined,
        undefined,
        "SELECT * FROM Vendor MAXRESULTS 1000",
      );
      console.log(
        JSON.stringify(
          {
            realmId: config.realmId,
            company: {
              name: company.CompanyName,
              country: company.Country ?? company.CompanyAddr?.Country,
            },
            accounts: (accounts.QueryResponse?.Account ?? []).map((a: any) => ({
              id: a.Id,
              name: a.Name,
              type: a.AccountType,
              active: a.Active,
            })),
            vendors: (vendors.QueryResponse?.Vendor ?? []).map((v: any) => ({
              id: v.Id,
              displayName: v.DisplayName,
              active: v.Active,
            })),
            limit: 1000,
            complete:
              (accounts.QueryResponse?.Account?.length ?? 0) < 1000 &&
              (vendors.QueryResponse?.Vendor?.length ?? 0) < 1000,
          },
          null,
          2,
        ),
      );
    } else {
      const mappings = (await json(option("--mappings"))) as Mappings;
      validateMappings(mappings, config.realmId);
      if (command === "mapping-check")
        console.log(
          JSON.stringify(await client.verifyMappings(mappings), null, 2),
        );
      else {
        const backend = process.env.QBO_CONVEX_URL,
          token = process.env.QBO_AUTH_TOKEN;
        if (!backend || !token)
          throw new QboError("authenticated_backend_configuration_required");
        const u = new URL(backend);
        if (
          u.protocol !== "https:" &&
          !(
            u.protocol === "http:" &&
            ["127.0.0.1", "localhost"].includes(u.hostname)
          )
        )
          throw new QboError("secure_backend_required");
        const api = new ConvexHttpClient(backend);
        api.setAuth(token);
        const scope = JSON.parse(process.env.AP_BANK_SCOPE ?? "null");
        const caseId = option("--case");
        if (!scope || !caseId) throw new QboError("scoped_case_required");
        const request: ExportRequest = {
          caseId,
          ...(option("--payment-version")
            ? { paymentVersionId: option("--payment-version")! }
            : {}),
        };
        const load = async (r: ExportRequest) =>
          (await api.query(
            makeFunctionReference<"query">("apAccountingExport:current"),
            { scope, ...r },
          )) as AccountingExport;
        const journal = new SyncJournal(store, client);
        const dispatcher = new QuickBooksDispatcher(load, mappings, journal);
        if (command === "verify") {
          const result = await dispatcher.run(request, "dry-run");
          const plan = "plan" in result ? result.plan : null;
          if (!plan) throw new QboError("operation_missing");
          const op = await journal.get(plan);
          if (!op || op.state !== "succeeded")
            throw new QboError("successful_operation_required");
          await client.verify(op);
          console.log(
            JSON.stringify({
              state: "verified",
              externalId: op.externalId,
              syncToken: op.syncToken,
              requestId: op.requestId,
            }),
          );
        } else
          console.log(
            JSON.stringify(await dispatcher.run(request, "submit"), null, 2),
          );
      }
    }
  }
} catch (e) {
  console.error(safeError(e));
  process.exitCode = 1;
}
