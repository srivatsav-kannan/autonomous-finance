# Copyable AP implementation launch

Prepared only. No goal, implementation worker, worktree or service is launched by this file. Submit the command below only when ready to start implementation, in the Codex chat composer for this project. `/goal` is a chat command, not a shell command. One Master goal dispatches the workstreams.

```text
/goal 按 /Users/junjiexiong/Desktop/calhacks/docs/ap-orchestration/MASTER.md 及其中引用的 WORKSTREAMS.md、plan.json、API-READINESS.md、LLAMAPARSE-GROUNDING.md 和 issue #97，完成完整 AP system roadmap。你担任唯一 Master，允许为此目标使用 bounded subagents、创建必要的隔离 worktrees，并集成和验证它们的改动。先完成 P0：重新确认 main/spec，保留我的本地改动，复制尚未提交的启动包到 integration worktree，登记唯一 canonical registry，并隔离 backend、ports 和 run IDs；再完成 C0，共享 contract 固定后分派 A/B/C/D。按依赖和实际并发上限调度，初始最多三个 delegated workers，留出或轮换独立 verifier；owner 自己也执行任务。把已验证的 native → raw-word exact alignment → bounded local OCR → unresolved 方案纳入 A2，明确 derived geometry、失败处理和验收。复用现有 server-only credentials 与当前模型设置，显式选择正确的 invoice live/provider 配置。所有贡献先验收再更新状态；先通过同一 case 的 FakeBank 闭环和 recovery，再验证 Increase，然后继续完整 roadmap。缺少外部条件时记录 blocker 并继续独立工作；不要把单样本成功或未完成任务报告成整个目标完成。只操作本目标拥有的资源，不覆盖既有 preview、合并 main、部署 production 或执行真实资金付款。
```

The instruction references the reviewed launch pack by absolute path because it is currently untracked and will not appear in a new main worktree automatically. P0 creates the authoritative runtime registry location; its `canonical_path` remains null until then. The original private provider file stays outside source control. No new API registration is required for the first wave.

## Responsibilities

| Role | Task IDs | Concrete responsibility |
| --- | --- | --- |
| Master | P0, C0, I1, FINAL | Pin source/spec; assign exclusive files and isolated environments; freeze contracts; own the registry, integration branch and independent acceptance. |
| A — Evidence & Data | A1, A2 | Golden State PDF/PO/receipt packet; LlamaParse adapter; native/raw-word/local-OCR grounding and explicit unresolved results. |
| B — AP & Accounting | B1, B2, B3, B4 | Matching/policy/owned exceptions; reviewed candidate to bill; accounting entries, broader cases and period-close controls. |
| C — Payments & Integrations | C1, C2, C3, C4 | Reuse durable payment execution; same-case handoff; Increase tests, business scheduling and selected ERP sync. |
| D — Experience & Assurance | D1, D2 | Polished case workspace; native/derived/unresolved highlights; approvals, exceptions, accounting and audit timeline; browser evidence. |
| Independent verifier | V1, V2; final acceptance support | Review expected results independently, verify negative/recovery cases and report directly to Master. D's implementation self-checks do not replace this role. |

## How work moves

1. Master completes P0 and C0 before dispatching dependent implementation. A worker cannot invent a competing evidence contract or shared schema.
2. With four available slots including Master, start A/B/D on independent scopes; rotate C and verifier into free slots. The runtime's actual limit takes precedence. These are logical roles, not permanent management-only sessions.
3. Each assignment includes task ID, source/spec/contract version, canonical registry, worktree, backend/ports, owned/excluded files and acceptance evidence. Workers can split useful independent work only when slots and ownership allow it.
4. Workers report changes, tests, artifacts, unresolved gaps and commits/PRs to Master. Only Master updates the canonical `plan.json`; status polling cannot replace inspecting the result.
5. I1 integrates the same uploaded source through review, AP, authorization, FakeBank and accounting. V2 checks failures/recovery before C2 external Increase verification. Scheduling and ERP remain separate; missing ERP access does not block scheduling.
6. The full issue remains the objective. Additional formats/cases, controls, close, external sync and independent domain acceptance retain their own gates. Sandbox readiness and local OCR success do not satisfy those gates.

Separate persistent user-owned chats can be requested later if useful; this command uses subagents and requires no manual launch of four duplicate goals. No application orchestration service or extra API is introduced by this launch pack.

## Inspect or steer after launch

Use `/goal` to inspect the current goal. To request progress, ask Master for the canonical registry, accepted task IDs, active worktrees, blockers and latest verification evidence. The official command guide also documents `/goal pause` and `/goal resume` for controlling an active goal; merely reading this file does not invoke them.

Sources: [official `/goal` command](https://learn.chatgpt.com/docs/developer-commands), [official subagent guidance](https://learn.chatgpt.com/docs/agent-configuration/subagents).
