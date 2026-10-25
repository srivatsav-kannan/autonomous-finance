// Human approval accepts JWTs from this configured issuer only. Agent seat tokens and
// service secrets cannot authenticate as humans. Tests use explicit simulated identities.
import type { AuthConfig } from "convex/server";
export default {
  providers: process.env.AP_HUMAN_AUTH_ISSUER && process.env.AP_HUMAN_AUTH_AUDIENCE
    ? [{ domain: process.env.AP_HUMAN_AUTH_ISSUER, applicationID: process.env.AP_HUMAN_AUTH_AUDIENCE }]
    : [],
} satisfies AuthConfig;
