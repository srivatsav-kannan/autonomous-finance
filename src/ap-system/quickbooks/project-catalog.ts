/** Read-only Projects GraphQL adapter. Separate, already-authorized grant; never starts OAuth. */
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { PrivateStore, QboError, hash } from "./private-store";
import type { Transport } from "./oauth";
import type { ProjectCatalog, ProjectCatalogVerifier } from "./dimensions";

export const PROJECT_SCOPE = "project-management.project";
export const PROJECT_ENDPOINT = "https://qb-sandbox.api.intuit.com/graphql";
const QUERY =
  "query APProjectCatalog($id: ID!) { projectManagementProject(id: $id) { id name status account { id } customer { id } } }";
const validId = (v: unknown): v is string =>
  typeof v === "string" && /^\d{1,32}$/.test(v);
const record = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
export type ProjectCatalogConfig = {
  version: "ap-qbo-project-catalog-v1";
  environment: "sandbox";
  realmId: string;
  ttlMs: number;
  /** Explicit reviewed usable states; no inference that completed/cancelled projects are active. */
  acceptedStatuses: Array<"ACTIVE" | "IN_PROGRESS">;
};
/** Written by the owner of a completed normal OAuth grant, not by a browser request or env flag. */
export type ProjectGrant = {
  version: "ap-qbo-project-grant-v1";
  environment: "sandbox";
  grantId: string;
  clientHash: string;
  realmId: string;
  scopes: string[];
  authorizedAt: number;
  accessToken: string;
  expiresAt: number;
};
export type ProjectGrantSource = () => Promise<ProjectGrant | null>;
function checkConfig(c: ProjectCatalogConfig) {
  if (
    !c ||
    c.version !== "ap-qbo-project-catalog-v1" ||
    c.environment !== "sandbox" ||
    !validId(c.realmId) ||
    !Number.isSafeInteger(c.ttlMs) ||
    c.ttlMs < 1000 ||
    c.ttlMs > 300000 ||
    !Array.isArray(c.acceptedStatuses) ||
    !c.acceptedStatuses.length ||
    c.acceptedStatuses.some((s) => !["ACTIVE", "IN_PROGRESS"].includes(s)) ||
    new Set(c.acceptedStatuses).size !== c.acceptedStatuses.length
  )
    throw new QboError("project_catalog_configuration_required");
}
function checkGrant(
  g: ProjectGrant | null,
  c: ProjectCatalogConfig,
  now: number,
): asserts g is ProjectGrant {
  if (
    !g ||
    g.version !== "ap-qbo-project-grant-v1" ||
    g.environment !== "sandbox" ||
    g.realmId !== c.realmId ||
    typeof g.grantId !== "string" ||
    !g.grantId.trim() ||
    g.grantId.length > 240 ||
    !/^[a-f0-9]{64}$/.test(g.clientHash) ||
    !Array.isArray(g.scopes) ||
    !g.scopes.includes(PROJECT_SCOPE) ||
    !Number.isSafeInteger(g.authorizedAt) ||
    g.authorizedAt < 0 ||
    g.authorizedAt > now ||
    !Number.isSafeInteger(g.expiresAt) ||
    g.expiresAt <= now + 1000 ||
    typeof g.accessToken !== "string" ||
    !g.accessToken ||
    g.accessToken.length > 16384
  )
    throw new QboError("project_authorized_grant_required");
}
async function responseBody(res: Response) {
  const reader = res.body?.getReader();
  if (!reader) throw new QboError("project_catalog_invalid_response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 256 * 1024) {
      await reader.cancel();
      throw new QboError("project_catalog_response_too_large");
    }
    chunks.push(value);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return { raw, data: JSON.parse(raw) as unknown };
  } catch {
    throw new QboError("project_catalog_invalid_json");
  }
}
export class ProjectCatalogClient {
  constructor(
    readonly config: ProjectCatalogConfig,
    readonly grant: ProjectGrantSource,
    readonly store: PrivateStore,
    readonly transport: Transport = fetch,
    readonly now = Date.now,
    readonly sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ) {
    checkConfig(config);
  }
  readonly verify: ProjectCatalogVerifier = async (request) => {
    checkConfig(this.config);
    if (
      request.realmId !== this.config.realmId ||
      !Array.isArray(request.projectIds) ||
      request.projectIds.length < 1 ||
      request.projectIds.length > 25 ||
      request.projectIds.some((id) => !validId(id)) ||
      new Set(request.projectIds).size !== request.projectIds.length
    )
      throw new QboError("project_catalog_request_invalid");
    const started = this.now(),
      deadline = started + 60000;
    const projects: ProjectCatalog["projects"] = [],
      responses: Array<{
        id: string;
        sha256: string;
        requestHash: string;
        traceIdHash: string | null;
      }> = [];
    let grant = await this.grant();
    checkGrant(grant, this.config, this.now());
    const grantBinding = hash({
      grantId: grant.grantId,
      clientHash: grant.clientHash,
      realmId: grant.realmId,
      authorizedAt: grant.authorizedAt,
      scopes: grant.scopes,
    });
    for (const id of [...request.projectIds].sort()) {
      const body = JSON.stringify({ query: QUERY, variables: { id } });
      let refreshed = false,
        complete = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (this.now() >= deadline)
          throw new QboError("project_catalog_deadline");
        checkGrant(grant, this.config, this.now());
        let res: Response;
        try {
          res = await this.transport(PROJECT_ENDPOINT, {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(
              Math.max(1, Math.min(15000, deadline - this.now())),
            ),
            headers: {
              Authorization: `Bearer ${grant.accessToken}`,
              Accept: "application/json",
              "Content-Type": "application/json",
            },
            body,
          });
        } catch {
          throw new QboError("project_catalog_transport_failed");
        }
        if (res.status === 401 && !refreshed) {
          await res.body?.cancel();
          const next = await this.grant();
          checkGrant(next, this.config, this.now());
          if (
            next.accessToken === grant.accessToken ||
            hash({
              grantId: next.grantId,
              clientHash: next.clientHash,
              realmId: next.realmId,
              authorizedAt: next.authorizedAt,
              scopes: next.scopes,
            }) !== grantBinding
          )
            throw new QboError("project_grant_reauthorization_required");
          grant = next;
          refreshed = true;
          continue;
        }
        if (res.status === 429 || res.status >= 500) {
          const retry = res.headers.get("retry-after");
          await res.body?.cancel();
          const delay = retry
            ? /^\d+$/.test(retry)
              ? Number(retry) * 1000
              : Date.parse(retry) - this.now()
            : 1000;
          if (
            attempt === 2 ||
            !Number.isFinite(delay) ||
            delay < 0 ||
            delay > 5000 ||
            this.now() + delay >= deadline
          )
            throw new QboError("project_catalog_retry_later");
          await this.sleep(Math.max(100, delay));
          continue;
        }
        if (!res.ok) {
          await res.body?.cancel();
          throw new QboError(
            res.status === 401
              ? "project_grant_reauthorization_required"
              : res.status === 403
                ? "project_catalog_entitlement_required"
                : "project_catalog_request_rejected",
          );
        }
        const { raw, data } = await responseBody(res);
        if (
          !record(data) ||
          (data.errors !== undefined &&
            (!Array.isArray(data.errors) || data.errors.length !== 0)) ||
          !record(data.data) ||
          !record(data.data.projectManagementProject)
        )
          throw new QboError("project_catalog_incomplete_or_denied");
        const p = data.data.projectManagementProject;
        if (
          p.id !== id ||
          !record(p.account) ||
          p.account.id !== this.config.realmId ||
          !record(p.customer) ||
          !validId(p.customer.id) ||
          typeof p.name !== "string" ||
          !p.name.trim() ||
          p.name.length > 240 ||
          !this.config.acceptedStatuses.includes(p.status)
        )
          throw new QboError("project_catalog_identity_or_status_conflict");
        const responseHash = sha(raw),
          trace = res.headers.get("intuit_tid");
        // Only private raw response data; Authorization/access tokens never enter the artifact or receipt.
        await this.store.write(`project-response-${responseHash}.json`, {
          version: "ap-qbo-project-response-v1",
          endpoint: PROJECT_ENDPOINT,
          realmId: request.realmId,
          projectId: id,
          observedAt: this.now(),
          requestHash: sha(body),
          responseSha256: responseHash,
          traceIdHash: trace ? sha(trace) : null,
          raw,
        });
        responses.push({
          id,
          sha256: responseHash,
          requestHash: sha(body),
          traceIdHash: trace ? sha(trace) : null,
        });
        projects.push({
          id,
          name: p.name,
          customerId: p.customer.id,
          active: true,
        });
        complete = true;
        break;
      }
      if (!complete) throw new QboError("project_catalog_retry_later");
    }
    const observedAt = this.now(),
      validUntil = Math.min(grant.expiresAt, started + this.config.ttlMs);
    if (observedAt >= deadline || validUntil <= observedAt)
      throw new QboError("project_catalog_expired_during_read");
    const result: ProjectCatalog = {
      realmId: request.realmId,
      observedAt,
      validUntil,
      scope: PROJECT_SCOPE,
      projects,
      responseHash: hash(responses),
      entitlementHash: hash({
        proof: "successful_authorized_project_reads",
        endpoint: PROJECT_ENDPOINT,
        grantBinding,
        responses,
        observedAt,
      }),
    };
    await this.store.write(`project-catalog-${hash(result)}.json`, result);
    return result;
  };
}
/** Lazy server-only configuration. An absent path keeps the existing accounting-only grant unchanged.
 * The normal OAuth owner supplies project-grant.json after obtaining the separate scope; this adapter
 * neither imports tokens from the accounting grant nor starts/expands any consent flow. */
export function configuredProjectCatalog(
  env: NodeJS.ProcessEnv = process.env,
  transport: Transport = fetch,
): ProjectCatalogVerifier | undefined {
  const root = env.QBO_PROJECTS_PRIVATE_DIR;
  if (!root) return undefined;
  if (!isAbsolute(root))
    throw new QboError("project_catalog_private_path_required");
  const store = new PrivateStore(root);
  return async (request) => {
    const config = await store.read<ProjectCatalogConfig>(
      "project-catalog-config.json",
    );
    if (!config) throw new QboError("project_catalog_configuration_required");
    const client = new ProjectCatalogClient(
      config,
      () => store.read<ProjectGrant>("project-grant.json"),
      store,
      transport,
    );
    return client.verify(request);
  };
}
