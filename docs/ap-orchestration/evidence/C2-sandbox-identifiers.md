# Observed Increase sandbox resource identifiers

On2026-10-25, two read-only authenticated requests to the already configured Increase sandbox returned exactly the configured IDs: account typeaccount/statusopen/currencyUSD with prefixsandbox_account_, and external account typeexternal_account/statusactive with prefixsandbox_external_account_. No funding, transfer or other provider write was made. Private identifiers and credentials are omitted.

The previous bootstrap and adapter accepted only account_/external_account_ and therefore rejected these real sandbox resources before normal Auth0 setup. Validation now accepts either the traditional format or one exactsandbox_ prefix, with an alphanumeric nonempty suffix. Sandbox origin, environment, full scoped identity, immutable request/body/hash, provider readback identity and HMAC verification are unchanged. Resource path and operator harness checks use the same bounded prefix grammar; traversal/query/empty/wrong resource-kind identifiers remain rejected. This does not enable production.

55 focused Increase/bootstrap/independent bootstrap tests passed. Three new checks exercise exact saved sandbox-prefixed command submission and GET recovery with synthetic transport, invalid path/production scope rejection, signed event integrity and bootstrap preparation without enrollment. Actual bank execution and webhook delivery remain NOT_RUN.

Provider context: [official API authorization and sandbox testing](https://www.increase.com/documentation/api/overview). The specific ID prefixes above were observed from the configured sandbox; API examples alone were not taken as evidence of a successful transaction.
