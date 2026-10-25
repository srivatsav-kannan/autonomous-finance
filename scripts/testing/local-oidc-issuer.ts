/** Local-only OIDC test issuer for browser approval against a local Convex backend.
 * Binds to loopback, serves discovery and JWKS for one fresh RSA key, and signs short-lived
 * test JWTs. It never loads provider credentials and is not a production identity.
 */
import http from "node:http";
import { generateKeyPairSync, sign } from "node:crypto";

export type LocalOidcIssuer = {
  issuer: string;
  audience: string;
  subject: string;
  /** Convex `tokenIdentifier` (issuer|subject) to bind to the human CFO seat. */
  tokenIdentifier: string;
  token(overrides?: Record<string, unknown>): string;
  close(): void;
};

export async function startLocalOidcIssuer(audience: string, subject = "browser-human"): Promise<LocalOidcIssuer> {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "ap-browser-test", alg: "RS256", use: "sig" };
  let issuer = "";
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/.well-known/openid-configuration") res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/.well-known/jwks.json`, response_types_supported: ["id_token"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"] }));
    else if (req.url === "/.well-known/jwks.json") res.end(JSON.stringify({ keys: [jwk] }));
    else { res.statusCode = 404; res.end("{}"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return {
    issuer, audience, subject, tokenIdentifier: `${issuer}|${subject}`,
    token(overrides = {}) {
      const now = Math.floor(Date.now() / 1000);
      const bytes = `${encode({ alg: "RS256", typ: "JWT", kid: jwk.kid })}.${encode({ iss: issuer, sub: subject, aud: audience, iat: now, exp: now + 3600, ...overrides })}`;
      return `${bytes}.${sign("RSA-SHA256", Buffer.from(bytes), privateKey).toString("base64url")}`;
    },
    close() { server.closeAllConnections(); server.close(); },
  };
}
