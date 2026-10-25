# API and environment readiness

Updated 2026-10-25, America/Los_Angeles. **Environment preparation only; implementation has not started.** Provider authentication checks and one tiny OpenAI inference request completed. Reused the existing LlamaCloud key and created a standalone Increase API sandbox with synthetic fixture resources. Five isolated LlamaParse jobs have completed across three rounds: the malformed PDF/derived TIFF pair, clean PDF/archival scan controls, and the same scan with raw word output. Native description grounding remains missing, but a local Tesseract fallback uniquely located both description lines and passed original-image overlay review. This verifies one diagnostic fallback, not application integration. See `LLAMAPARSE-SMOKE.md`, `LLAMAPARSE-CONTROLS.md` and `LLAMAPARSE-GROUNDING.md`. No business workflow, transfer, funding simulation, deployment, or service restart was triggered. Existing checkout changes and `.env.local` files were preserved.

Expanded discovery covered the Desktop checkout, local `calhacks` worktrees, the private evaluation directory, relevant shell configuration declarations, and the inspection process environment. Only names/presence were reported. Absence here does not prove no credential exists in any other account or secret store.

| Dependency | Observed state | Gate / next action |
| --- | --- | --- |
| Codex orchestration | App tools, subagents and managed worktrees available; CLI 0.163.0-alpha.11.1 installed. No custom /go found. | Use built-in /goal; inherit the user's model. No extra app API key required merely to use the current signed-in chat. |
| OpenAI app inference | Reused the key from `external-finance-evals/calhacks/.env.local`. Model-list authentication returned 200. One `gpt-6.1-sol` Responses request returned 200, completed and the expected READY output (18 total tokens). | No new key required. Configuration import verified in main-browser-recovery; application workflow not run. |
| OpenAI Decisions | Not integrated; app's review endpoint with a similar name is unrelated. | Optional classification/scoring adapter. Verify endpoint/model/SDK support and account access before claiming ready. |
| LlamaParse | Existing key from the user's signed-in Default project reused; project/organization IDs recorded locally. Metadata API returned 200. | Provider controls completed: clean PDF has 9/9 fields and 30/30 exact cells with boxes; genuine scanned JPEG has 9/9 normalized fields and 2/2 normalized cells, but only 1/2 native cell boxes. Raw word output did not fix that; local Tesseract PSM 6 supplied verified derived description-line regions on this sample. App adapter and broader validation remain pending. No new credential needed. |
| Convex | All three inspected local backends returned 200 for `/version`. Main-browser invoice `/workspace` returned valid JSON with 200, exercising its existing workspace read path. | This does not verify the planned bridge or schema compatibility with a future integration commit. |
| Human gateway | Main-browser gateway returned 401 without a token and 200 for a read-only request using its existing token and allowed origin. | Token is reusable with that environment. It is a local console mechanism, not proof of production identity controls. |
| FakeBank | Stateful implementation and recovery harness exist; no external bank key needed. | First integrated closed-loop target. Fresh same-case verification still required. |
| Increase sandbox | Standalone API sandbox created. Key, source account ID, external account ID and synthetic Entity ID saved. Auth and both resource reads returned 200; source open, destination active; Entity validation simulated valid. | Source balance is 0 USD. Payment/recovery tests, funding and webhook delivery not run. No dashboard association established. |
| External accounting/ERP | No selected verified connector for this roadmap. | Record provider decision and environment before that task. Do not substitute an internal journal for verified external sync. |

Preserve separate states: NOT_CONFIGURED, CONFIGURED, AUTH_VERIFIED, INFERENCE_VERIFIED, WORKFLOW_VERIFIED, BLOCKED. Never write secret values in this table or plan.json.

Existing app configuration has separate deterministic/live switches and spend limits. Reconcile those with the user's quality-first preference before tests; do not silently downgrade models, disable authorization, or claim a budget-exhausted run is complete. Explicitly select the configured provider rather than falling through to an unconfigured default.

Work that can proceed without further credentials: fixture export/rendering, shared contracts, deterministic controls, bridge implementation, UI against a fixed contract, exact journal assertions and local FakeBank recovery. OpenAI authentication/inference, LlamaCloud metadata access and Increase sandbox resource access now work. Standalone LlamaParse parsing has now been exercised, with omissions and unsupported text recorded in `LLAMAPARSE-SMOKE.md`; application integration and representative-format acceptance still require implementation/tests. Increase payment verification requires a deliberately funded test scenario and workflow tests; dashboard signup is not required.

Implementation baseline must be fixed at launch: remote main was 5e1126bd20765bad45c22007bb1f67ef25e2375e; Desktop was dirty at 5b9ef923ec91a1f329990d3cb058e8316850d4c9; attached worktree was clean at 0e98be5aa869149d4147916e47c3a57746b07230. No checkout was reset or advanced by this preparation.

## Local provider configuration

Created `/Users/junjiexiong/Desktop/calhacks/var/ap-environment/providers.env`, mode 0600 in a private directory. Git ignores it. It contains the verified OpenAI key, `AGENT_PROVIDER=openai`, `AGENT_MODEL=gpt-6.1-sol`, the LlamaCloud key/project/organization IDs, and the Increase sandbox key/source/destination/Entity IDs. The optional webhook secret remains empty. The prior private evaluation `openai.env` was empty; the working OpenAI key came from the evaluation worktree instead.

This is a server-only configuration, loaded explicitly into the selected runtime. Existing services do not automatically consume it. Do not put provider keys in browser-side `VITE_*` variables. `providers.env.example` here is a shareable empty template, not a live configuration.

## Configuration details and future credential replacement

No further user login or credential entry is needed for the configured API baseline. Keep credentials out of chat, commits and screenshots. The provider file is local only; future server processes must load it explicitly.

Account setup follow-up on 2026-10-25: the user completed LlamaCloud login and confirmed they have no Increase account. The existing LlamaCloud key was reused without creating a new key. Increase was provisioned through its documented anonymous sandbox API, independently of a dashboard login.

### LlamaParse: one required key

**Configured; metadata access and five parsing jobs verified across three rounds.** See `LLAMAPARSE-SMOKE.md`, `LLAMAPARSE-CONTROLS.md` and `LLAMAPARSE-GROUNDING.md` for distinct content/grounding outcomes. The instructions below are for later replacement/rotation, not unfinished setup work.

1. Open [LlamaCloud](https://cloud.llamaindex.ai/), choose the intended project, then **API Key** and generate a key.
2. Set `LLAMA_CLOUD_API_KEY` in the local provider file. An existing active key can be reused when it has access to that project.
3. Run the metadata check below. A project-scoped key is the simplest starting point; if an organization-level setup requires it, add `LLAMA_CLOUD_ORGANIZATION_ID` for the checker.
4. Metadata access is not proof of parsing. The separate two-format smoke has run; the app adapter, broader corpus checks, complete evidence coverage and AP handoff remain implementation work.

Hosted LlamaParse does not require another OCR provider key. Keys are scoped to the user/project: [official API key guidance](https://developers.llamaindex.ai/llamaparse/general/api_key/), [getting started](https://developers.llamaindex.ai/llamaparse/parse/getting_started/), [project-list API](https://developers.llamaindex.ai/reference/python/resources/v2_projects/methods/list/).

### Document format coverage (provider capability, not implemented app support)

The requested input scope includes original PDFs, TIFFs, XML invoices and scanned images. One hosted LlamaCloud credential is sufficient for the LlamaParse routes; these do not require separate OCR keys.

| Input | Verified provider documentation | Planned application route / acceptance |
| --- | --- | --- |
| Digital PDF | Supported; existing PDF text is read directly. | Parse the original file; preserve pages, tables and source coordinates. |
| Scanned PDF | Supported; OCR runs on pages without a text layer. | Preserve original scans; identify unreadable pages and check completeness. |
| TIFF scans | TIFF is listed as supported. | Test representative single-page and multipage TIFFs; preserve page order. Support for every compression/multipage variant has not been established. |
| JPEG / PNG scans or photos | Supported image/OCR inputs. | Preserve original images, orientation and field locations; evaluate camera-photo correction for photographs. |
| XML invoices, including UBL | XML is listed by LlamaParse; UBL is structured business data. | Prefer deterministic XML/schema parsing into the same invoice contract, retaining element paths and original bytes as evidence. This route is our architecture recommendation, not a provider requirement. |

Sources: [supported document types](https://developers.llamaindex.ai/llamaparse/general/supported_document_types/), [OCR and languages](https://developers.llamaindex.ai/llamaparse/parse/features/ocr-and-languages/), [OASIS UBL 2.1](https://docs.oasis-open.org/ubl/os-UBL-2.1/UBL-2.1.html).

For later evidence highlighting, evaluate word/line/table-cell coordinates using [granular bounding boxes](https://developers.llamaindex.ai/llamaparse/parse/features/layout-and-bounding-boxes/). Review [provider file/request limits](https://developers.llamaindex.ai/llamaparse/general/limitations/) alongside application limits rather than inheriting them blindly. Representative files need independently checked field values, page coverage and evidence locations before calling a format verified.

In the inspected `main-browser-recovery` checkout at `0e98be5`, the browser directly uploads TXT/CSV/JSON, with its own 2 MB limit. PDF requires a JSON bundle carrying original bytes and pre-extracted text. The routine parser does not yet handle TIFF, image or XML MIME types. **Status: provider PDF and single-page derived-TIFF parsing exercised with partial extraction/grounding; a genuine archival JPEG scan also passed selected content checks with incomplete native description grounding; a local OCR fallback supplied verified derived line regions for that one scan; genuine scanned PDF/TIFF and other formats remain unverified; app adapters are not implemented.** This setup task does not implement those routes.

### Increase: key plus two resource IDs

**Configured and resource access verified.** The selected environment is a standalone API sandbox. The following dashboard paths are for a future dashboard-backed environment; they are not connected to the currently provisioned sandbox.

| Variable | Setup location | Meaning |
| --- | --- | --- |
| `INCREASE_SANDBOX_API_KEY` | [Increase API keys](https://dashboard.increase.com/developers/api_keys), Sandbox mode | Credential for the sandbox API. |
| `INCREASE_SANDBOX_ACCOUNT_ID` | [Accounts](https://dashboard.increase.com/accounts), Sandbox mode | Source account whose test funds the workflow will use. |
| `INCREASE_SANDBOX_EXTERNAL_ACCOUNT_ID` | Sandbox External Account resource, via dashboard if available or the [External Accounts API](https://increase.com/documentation/api/external-accounts) | Separately established destination resource; an account number is not this resource ID. |
| `INCREASE_SANDBOX_WEBHOOK_SECRET` | Sandbox webhook subscription | Optional for polling-based checks; needed when verifying signed webhook delivery. |

All three required values must refer to the intended sandbox. Authentication alone does not establish source balance, destination approval, payment capability, settlement, webhook delivery, or recovery correctness. Check those separately when workflow testing begins.

Provisioned through `POST https://sandbox.increase.com/groups`, with the one-time key saved immediately in private local storage. The sandbox includes `AP Sandbox - Operating (synthetic)` and `AP Sandbox - Test supplier (synthetic)`. A fresh Group had no default Entity, so a synthetic corporation was created using documentation fixture identity fields before creating the account. Entity validation was explicitly simulated as valid; this is not real KYC. Source and available balances were both 0 USD; no transfer was created.

The test destination uses the documented Example Bank routing number and a synthetic account number. Setup idempotency keys, fixture Entity ID and a redacted readiness report are saved under the ignored `var/ap-environment/` directory. The one-time Group response is also private there; do not publish or attach it. No extra Program or webhook subscription was required for this setup.

**No Increase signup is required for this API sandbox. Dashboard association is not established.** Do not promise that a later Increase sign-up will automatically display this anonymous sandbox. A dashboard demo needs a separately verified dashboard-backed setup or a provider-supported linking procedure. [Official sandbox documentation](https://increase.com/documentation/sandbox), [sandbox test values](https://increase.com/documentation/sandbox-test-values), [Entity API](https://increase.com/documentation/api/entities), [Entity validation](https://increase.com/documentation/entity-validation), [authorization/API reference](https://increase.com/documentation/api/overview.html).

### OpenAI: no action needed now

If the reused key later expires or is revoked, replace it through the same project's [API keys page](https://platform.openai.com/api-keys). Codex sign-in and application API credentials are separate. Authentication and inference were both checked here; model-list access alone would not establish inference access. [Official quickstart](https://developers.openai.com/api/docs/quickstart).

## Repeatable checks

The utility reads the prepared provider file directly and suppresses credentials and raw provider error bodies.

```bash
# Local presence/permissions only; no network or inference.
node /Users/junjiexiong/Desktop/calhacks/docs/ap-orchestration/check-environment.mjs

# Read-only metadata/resource requests for configured services.
node /Users/junjiexiong/Desktop/calhacks/docs/ap-orchestration/check-environment.mjs --online

# Adds one tiny OpenAI Responses request; still no business workflow or bank writes.
node /Users/junjiexiong/Desktop/calhacks/docs/ap-orchestration/check-environment.mjs --smoke
```

Read the returned states. Exit 0 means checks completed, not that missing prerequisites are ready. HTTP failure can reflect scope or permissions; network failure does not prove an invalid key. LlamaParse parsing and Increase payments always remain `NOT_RUN` in this utility, which does not execute those actions; the separate LlamaParse runs are documented in `LLAMAPARSE-SMOKE.md`, `LLAMAPARSE-CONTROLS.md` and `LLAMAPARSE-GROUNDING.md`. Restricted execution environments need network access for online checks.

## Running environments

Node 24.22.0 satisfies the >=24.18.0 requirement; npm 12.2.0 and Python 3.11.7 are available. All three checkouts have `node_modules` and lockfiles. Full builds/tests were not run. Docker CLI exists; daemon was not checked and is not needed for the current hosted APIs/local Convex.

| Checkout | Source at inspection | Frontend | Convex backend/site | Other listeners |
| --- | --- | --- | --- | --- |
| `main-browser-recovery` | `0e98be5`, clean | `http://127.0.0.1:5173/` -> 200 | 3240 / 3241; backend `/version` -> 200 | Human gateway 8787 and invoice server 8790 checked as above. |
| Desktop `calhacks` | `5b9ef92`, dirty | `http://127.0.0.1:5186/` -> 200 | 3220 / 3221; backend `/version` -> 200 | Node listener 8789; business health not checked. |
| `invoice-mvp-integration` | `75e9df5`, clean | `http://127.0.0.1:5184/` -> 200 | 3230 / 3231; backend `/version` -> 200 | Node listeners 8813 / 8814; business health not checked. |

The main-browser invoice server's `/api/invoice-mvp/runtime` reports source `0e98be5...`, `dirty=false`, **`mode=deterministic`**, no model/provider, and `liveExecution=disabled`. Do not describe the 5173 page as the new live AP system. Its workspace read path works; the planned AP integration is future work.

## Loading configuration later

Keep the selected checkout's `.env.local` for its Convex URL, kernel secret, gateway token and ports. Add the provider file to the server process explicitly. Node supports repeated `--env-file`; later files override earlier files, while pre-existing process environment variables take precedence.

For example, in an owned implementation checkout after checking ports: `node --env-file=.env.local --env-file=/Users/junjiexiong/Desktop/calhacks/var/ap-environment/providers.env --run=gateway`. This command was **not** run: 8787 is already occupied. A separate process only imported `src/agents/llm.ts` with these files and confirmed provider/model/credential availability without invoking a model.

Pin the intended source and allocate isolated ports/backends or agree on ownership before starting implementation. None of these running checkouts equals the last observed remote main above. Desktop's agent client is older and still Anthropic-oriented; adding a key does not update that source. No dependencies were upgraded or existing services restarted. Reconcile live-mode opt-in and per-run limits when implementation begins.

## /goal launch status after the parsing smoke

**Credentials ready; native scan grounding remains partial; a separately attributed OCR fallback has been verified on this scan; implementation not started.** No additional user API signup is required to begin the first implementation wave.

- Begin with P0: reconfirm/pin main and isolate worktree, backend, ports and run ownership. The previous readiness check recorded remote main at `5e1126bd20765bad45c22007bb1f67ef25e2375e` and issue #97 matching the saved snapshot after trimming whitespace; neither was refreshed in the latest grounding experiment. Preserve the dirty Desktop checkout and existing previews.
- Then C0: freeze source/evidence/normalized-candidate/review/bill/payment contracts, including native versus derived locations, coordinate frames, missing grounding, fallback provenance and parser failures. The format/grounding diagnostics inform this contract; they do not complete A2.
- Load the server-only provider file into the selected runtime explicitly. Invoice live execution has its own switches: `INVOICE_MVP_MODE=live_model` and `INVOICE_MVP_PROVIDER=openai`; `AGENT_PROVIDER=openai` alone does not select that invoice provider. Verify model and limits in the chosen source before launch. No live switches were changed here.
- Golden State linked PDF/PO/receipt packets, independent expected outcomes, the adapter, policy and AP bridge are implementation tasks. Actual AP practitioner review is still outstanding.
- Verify the integrated FakeBank case and recovery before Increase workflow tests. The plan now makes C2 depend on V2. Balance 0 is not a launch blocker; simulation funding belongs to the later authorized payment test. Webhook verification is a separate later gate.
- C3 business scheduling is separate from C4 external accounting integration. Only C4 needs ERP selection/access. Neither an Increase dashboard login nor a separate Decisions/Judge API is required for the first wave.

All 18 implementation tasks remain pending in `plan.json`, with mode `prepared_not_started`. No implementation goal or workstream chat was started.

Follow-up tests do not complete A2: the scan still lacks native description geometry, and its raw OCR words contain two transcription mismatches. Tesseract 5.5.2 with English data and PSM 6 uniquely matched both lines; PSM 3 did not. The accepted diagnostic supplies derived text regions, not native cell borders. Package/pin the fallback dependency in the eventual runtime, preserve rejection of ambiguous/unmatched text, and validate broader formats. No further API signup or service changes were needed. See `LLAMAPARSE-GROUNDING.md`.
