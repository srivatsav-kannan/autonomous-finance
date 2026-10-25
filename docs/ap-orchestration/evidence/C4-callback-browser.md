# QuickBooks OAuth callback — actual Chrome correction

Observed2026-10-25. User authorized fixing the local callback and continuing US sandbox OAuth plus read-only connection verification. No accounting write or bank payment is authorized by this setup step.

The original callback was reproduced in real Chrome: a valid form/session cookie was rejected by the exact Origin boundary. Non-sensitive server diagnostics showed `originIsNull:true`, `originMatches:false`, `originMissing:false`, and the expected form content type. The root document's `Referrer-Policy:no-referrer` caused this form POST behavior, consistent with [MDN Referrer-Policy documentation](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referrer-Policy).

The fix applies `same-origin` only to the local connection form. Sensitive callback/continuation responses retain `no-referrer`; exact Origin, loopback Host/peer, session cookie, one-use hashed OAuth state and CSRF checks remain required. Null, missing and cross-site Origin are still rejected.

The existing `default-src 'none'; form-action 'self'; frame-ancestors 'none'` CSP is unchanged. Instead of redirecting a form POST across origins, the validated POST returns a normal top-level link to the generated official Intuit authorization URL. This avoids browser-dependent form-action redirect blocking described in [MDN's form-action documentation](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/form-action). No scripts or broad external form destinations are permitted.

Two focused test files pass15tests, including wrong/null/missing Origin, bad CSRF, exact accounting-only scope, configured callback, one-use state, wrong session and redirection away from authorization code. Main TypeScript check passes.

After restarting only owned8824, actual Chrome diagnostics show `originIsNull:false`, `originMatches:true`. The normal link reaches the Intuit consent screen for AP Hyph and the configured Sandbox Company US683a. User confirmation is pending at this checkpoint. The private screenshot and readiness metadata remain in the ignored private setup directory; no OAuth query/code, keys, cookies or tokens are committed. Reaching consent is not OAuth completion, API-read success, or C4 external write acceptance.
