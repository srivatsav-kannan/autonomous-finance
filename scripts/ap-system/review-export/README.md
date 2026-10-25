# Export component evidence for an external Claude review

This optional observer captures real final in-memory Convex rows from selected existing scenarios. It is not part of the default test configuration and changes neither product code nor test assertions. Local identities, source stand-ins, FakeBank and protocol doubles stay synthetic; no provider config is loaded.

Run from the repository root with installed dependencies:

```sh
capture_dir=$(mktemp -d /private/tmp/ap97-claude-component-XXXXXX)
AP_REVIEW_CAPTURE_DIR="$capture_dir" ./node_modules/.bin/vitest run --config scripts/ap-system/review-export/capture.config.mjs --reporter=json --outputFile="$capture_dir/results.json"
```

Use a fresh directory; observations use exclusive-create writes. The final selection includes C11. The initial recorded run used an incorrect C11 name filter and therefore needed a second bounded invocation; that exact history and both filter hashes are retained in the component supplement receipt.

The observer preserves the original convexTest factory and reads selected tables only after each selected test. Some tests deliberately seed/adversarially modify rows; inspect the original test source. It excludes credential/config/seat tables. A record whose scope says Increase can still be a protocol fixture, not a real provider transaction.

When preparing a new packet, split exact source bytes/policy payloads from results. Validate every decoded chunk's source hash/length and retain any scope mismatch. Give originals/policy to Claude before results, freeze and hash the derivation, then reveal actual journals/business records. Preserve raw captures and source hashes. Never promote an existing test's expectation or a passing test title to independent business acceptance.

Recorded supplement: docs/ap-orchestration/claude-review/04-component-supplement/. Original handoff and phase manifests remain unchanged.
