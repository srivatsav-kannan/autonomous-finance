import { randomBytes, timingSafeEqual } from "node:crypto";
import { PrivateStore, QboError, hash } from "./private-store";
export const CALLBACK = "http://localhost:8824/api/quickbooks/callback";
export const SCOPE = "com.intuit.quickbooks.accounting";
const TOKEN = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
export type Config = {
  clientId: string;
  clientSecret: string;
  realmId: string;
  redirectUri: typeof CALLBACK;
  environment: "sandbox";
};
export type Transport = typeof fetch;
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  if (
    env.QBO_ENVIRONMENT !== "sandbox" ||
    env.QBO_REDIRECT_URI !== CALLBACK ||
    !/^\d{1,32}$/.test(env.QBO_REALM_ID ?? "") ||
    !env.QBO_CLIENT_ID ||
    !env.QBO_CLIENT_SECRET
  )
    throw new QboError("qbo_sandbox_configuration_required");
  return {
    clientId: env.QBO_CLIENT_ID,
    clientSecret: env.QBO_CLIENT_SECRET,
    realmId: env.QBO_REALM_ID!,
    redirectUri: CALLBACK,
    environment: "sandbox",
  };
}
type Token = {
  realmId: string;
  clientHash: string;
  access: string;
  refresh: string;
  accessUntil: number;
  refreshUntil: number;
  hardUntil: number | null;
  generation: number;
  blocked: boolean;
};
type State = {
  digest: string;
  sessionDigest: string;
  expiresAt: number;
  used: boolean;
  realmId: string;
  clientHash: string;
  redirectUri: string;
};
export async function boundedJson(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new QboError("invalid_provider_response", true);
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 2 * 1024 * 1024) {
      await reader.cancel();
      throw new QboError("provider_response_too_large", true);
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
      string,
      any
    >;
  } catch {
    throw new QboError("invalid_provider_json", true);
  }
}
export class OAuth {
  constructor(
    readonly config: Config,
    readonly store: PrivateStore,
    readonly transport: Transport = fetch,
    readonly now = Date.now,
  ) {
    if (
      config.environment !== "sandbox" ||
      config.redirectUri !== CALLBACK ||
      !/^\d{1,32}$/.test(config.realmId)
    )
      throw new QboError("qbo_sandbox_configuration_required");
  }
  async begin(session: string) {
    if (!/^[a-f0-9]{64}$/.test(session))
      throw new QboError("oauth_session_required");
    const state = randomBytes(32).toString("hex");
    const record: State = {
      digest: hash(state),
      sessionDigest: hash(session),
      expiresAt: this.now() + 600000,
      used: false,
      realmId: this.config.realmId,
      clientHash: hash(this.config.clientId),
      redirectUri: CALLBACK,
    };
    await this.store.write(`state-${record.digest}.json`, record);
    const url = new URL("https://appcenter.intuit.com/connect/oauth2");
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      response_type: "code",
      scope: SCOPE,
      redirect_uri: CALLBACK,
      state,
    }).toString();
    return url.toString();
  }
  async complete(url: URL, session: string) {
    if (
      url.origin + url.pathname !== CALLBACK ||
      url.searchParams.getAll("state").length !== 1 ||
      url.searchParams.getAll("code").length > 1 ||
      url.searchParams.getAll("realmId").length > 1
    )
      throw new QboError("invalid_oauth_callback");
    const state = url.searchParams.get("state") ?? "";
    if (!/^[a-f0-9]{64}$/.test(state))
      throw new QboError("invalid_oauth_state");
    await this.store.lock("oauth", async () => {
      const key = `state-${hash(state)}.json`;
      const s = await this.store.read<State>(key);
      if (
        !s ||
        s.used ||
        s.expiresAt <= this.now() ||
        s.clientHash !== hash(this.config.clientId) ||
        s.realmId !== this.config.realmId ||
        s.redirectUri !== CALLBACK ||
        !timingSafeEqual(
          Buffer.from(s.sessionDigest),
          Buffer.from(hash(session)),
        )
      )
        throw new QboError("invalid_oauth_state");
      await this.store.write(key, { ...s, used: true });
      if (url.searchParams.has("error"))
        throw new QboError("oauth_consent_denied");
      if (url.searchParams.get("realmId") !== this.config.realmId)
        throw new QboError("oauth_wrong_realm");
      const code = url.searchParams.get("code");
      if (!code || code.length > 512) throw new QboError("invalid_oauth_code");
      const token = await this.exchange(
        { grant_type: "authorization_code", code, redirect_uri: CALLBACK },
        0,
      );
      await this.store.write("tokens.json", token);
    });
  }
  private async exchange(
    body: Record<string, string>,
    generation: number,
  ): Promise<Token> {
    let res: Response;
    try {
      res = await this.transport(TOKEN, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          "x-include-refresh-token-hard-expires-in": "true",
        },
        body: new URLSearchParams(body).toString(),
      });
    } catch {
      throw new QboError("oauth_transport_unknown", true);
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new QboError(
        res.status === 400 || res.status === 401
          ? "oauth_reauthorization_required"
          : "oauth_endpoint_failed",
      );
    }
    const data = await boundedJson(res);
    const seconds = (v: unknown) =>
      typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v < 200000000
        ? v
        : null;
    const access = seconds(data.expires_in),
      refresh = seconds(data.x_refresh_token_expires_in),
      hard = seconds(data.x_refresh_token_hard_expires_in);
    if (
      typeof data.access_token !== "string" ||
      !data.access_token ||
      data.access_token.length > 16384 ||
      typeof data.refresh_token !== "string" ||
      !data.refresh_token ||
      data.refresh_token.length > 16384 ||
      data.token_type?.toLowerCase() !== "bearer" ||
      !access ||
      !refresh
    )
      throw new QboError("invalid_oauth_tokens");
    return {
      realmId: this.config.realmId,
      clientHash: hash(this.config.clientId),
      access: data.access_token,
      refresh: data.refresh_token,
      accessUntil: this.now() + access * 1000,
      refreshUntil: this.now() + refresh * 1000,
      hardUntil: hard ? this.now() + hard * 1000 : null,
      generation: generation + 1,
      blocked: false,
    };
  }
  async access(rejectedToken?: string): Promise<string> {
    return this.store.lock("oauth", async () => {
      const t = await this.store.read<Token>("tokens.json");
      if (
        !t ||
        t.blocked ||
        t.realmId !== this.config.realmId ||
        t.clientHash !== hash(this.config.clientId) ||
        t.refreshUntil <= this.now() ||
        (t.hardUntil !== null && t.hardUntil <= this.now())
      )
        throw new QboError("oauth_reauthorization_required");
      if (
        t.accessUntil > this.now() + 60000 &&
        (!rejectedToken || rejectedToken !== t.access)
      )
        return t.access;
      // Persist ambiguous rotation before sending; a crash cannot reuse a possibly spent refresh token.
      await this.store.write("tokens.json", { ...t, blocked: true });
      const next = await this.exchange(
        { grant_type: "refresh_token", refresh_token: t.refresh },
        t.generation,
      );
      if (t.hardUntil !== null)
        next.hardUntil = Math.min(t.hardUntil, next.hardUntil ?? t.hardUntil);
      await this.store.write("tokens.json", next);
      return next.access;
    });
  }
}
