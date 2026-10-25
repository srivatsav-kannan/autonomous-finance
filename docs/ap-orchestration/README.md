# AP system orchestration launch pack

Prepared on 2026-10-25. **Historical launch pack; the setup narrative below is not current implementation status.**

Current branch handoff: [TEAMMATE-HANDOFF.md](../../TEAMMATE-HANDOFF.md). See [Hyphenate demo](HYPHENATE-DEMO.md) and [its verified results](evidence/hyphenate-20261025/RESULTS.md), plus the separately completed [Increase/QBO sandbox flow](evidence/agent-live-20261025/ROLLOUT.md).

本启动包把 issue #97 转成可分派、可验收的工作。它不创建新的 orchestration 服务；使用 Codex 现有的 `/goal`、sessions、subagents 和 worktrees。机器可读清单是任务登记表，不是已经运行的 scheduler。

2026-10-25 环境准备已更新：旧 OpenAI key 已通过实际 Responses 调用；LlamaCloud 现有 key 已复用并验证 metadata 访问；独立 Increase API sandbox、测试 Entity、付款账户和合成收款方已创建并验证，余额为 0，未绑定 dashboard。本地页面、Convex、document workspace 和 human gateway 的只读访问已验证。LlamaParse 已实际处理一个 benchmark PDF 和它的 image-only TIFF，API 均成功，但发现 invoice number 遗漏、description 改写和部分 cell 缺坐标；详见 `LLAMAPARSE-SMOKE.md`。首轮是同一 invoice 的两种格式。后续已测试正常排版的 PDF 和真实历史扫描件：正常 PDF 的内容及 cell 坐标通过，真实扫描件内容正确但 description 坐标仍缺失，见 `LLAMAPARSE-CONTROLS.md`。随后同一扫描件加 raw words 输出仍缺原生 description box，但本机 Tesseract fallback 已唯一匹配两行并通过原图坐标复核；这是单样本验证，尚未接入应用，见 `LLAMAPARSE-GROUNDING.md`。配置和格式支持边界见 `API-READINESS.md`。现有 5173 页面仍是旧 commit 的 deterministic runtime，没有启动新的实现或 live AP workflow。

## 启动

准备好启动实现时，在 calhacks 项目的 Codex chat 输入框中粘贴下方唯一 Master 指令。完整说明见 [LAUNCH.md](LAUNCH.md)：

```text
/goal 按 /Users/junjiexiong/Desktop/calhacks/docs/ap-orchestration/MASTER.md 及其中引用的 WORKSTREAMS.md、plan.json、API-READINESS.md、LLAMAPARSE-GROUNDING.md 和 issue #97，完成完整 AP system roadmap。你担任唯一 Master，允许为此目标使用 bounded subagents、创建必要的隔离 worktrees，并集成和验证它们的改动。先完成 P0：重新确认 main/spec，保留我的本地改动，复制尚未提交的启动包到 integration worktree，登记唯一 canonical registry，并隔离 backend、ports 和 run IDs；再完成 C0，共享 contract 固定后分派 A/B/C/D。按依赖和实际并发上限调度，初始最多三个 delegated workers，留出或轮换独立 verifier；owner 自己也执行任务。把已验证的 native → raw-word exact alignment → bounded local OCR → unresolved 方案纳入 A2，明确 derived geometry、失败处理和验收。复用现有 server-only credentials 与当前模型设置，显式选择正确的 invoice live/provider 配置。所有贡献先验收再更新状态；先通过同一 case 的 FakeBank 闭环和 recovery，再验证 Increase，然后继续完整 roadmap。缺少外部条件时记录 blocker 并继续独立工作；不要把单样本成功或未完成任务报告成整个目标完成。只操作本目标拥有的资源，不覆盖既有 preview、合并 main、部署 production 或执行真实资金付款。
```

这是将来启动实现的指令；本次仅准备文件。`/goal` 本身不会自动定义团队结构，MASTER.md 和 WORKSTREAMS.md 才规定分工和验收。

## 分工

| Owner | 职责 |
| --- | --- |
| Master | 固定接口、任务登记、依赖调度、集成分支、共享 schema 与最终验收 |
| A: Evidence & Data | Golden State 文件包、PDF/PO/receipt、LlamaParse、grounding fallback 与字段证据 |
| B: AP & Accounting | document-to-AP bridge、matching、policy、exceptions、journals |
| C: Payments & Integrations | payment handoff、recovery、Increase、scheduling、后续 ERP |
| D: Experience & Assurance | case workspace、native/derived/unresolved highlights、审批/异常 UX、浏览器证据 |
| Independent verifier | 独立核验 expected outcomes、负例与 recovery，直接向 Master 汇报 |

Independent verifier 不应验证自己写的功能，也不能以 agent 答案生成 expected outcomes。

默认一个 Master goal 配合 bounded subagents；A/B/C/D 是逻辑职责，owner 自己也执行工作。当前 subagent tree 有包含 root 在内的 4 个活动槽，这不是账户总上限。P0/C0 后可先调度 A/B/D，再把 C 或 verifier 轮换到空闲槽位。只有容量和独立任务允许时才继续拆分 worker。Master 直接分配独立 verifier，所有 worker 回报结果，由 Master 独占写入 canonical registry。

启动包目前 untracked，新 main worktree 不会自动包含它。P0 必须只复制明确允许的启动文档/计划，记录 hash，并指定唯一 canonical registry 的绝对路径；不把整个 dirty checkout、var/ 或密钥复制进 Git。

## 顺序

1. 固定 main SHA、原有工作边界、API readiness 和共享 contract。
2. 并行完成 data/parser、AP/policy 和基于 contract 的 UI；核查现有 payment engine。
3. 集成第一条 PDF → review → bill → authorization → FakeBank → journal/reconciliation。
4. 验证冲突、revision、重复输入、拒绝授权、crash/recovery。
5. 完成外部 sandbox、多 supplier/non-PO/credits、scheduling、period close 和选定的 ERP connector。

后续阶段也是 roadmap 的组成部分。凭证或 provider 决策未解决时记录 blocker，继续不依赖它的工作；不能将 stub 改称完成。

## Decision / Judge

这三层用途不同：

- **Business policy enforcement**：金额计算、权限、审批版本、锁期、幂等由确定性的后端检查执行。模型不能授权自己付款。
- **Model decision support**：保留现有 Responses 路径用于调查、结构化提议和解释。可在可替换 adapter 后试用 OpenAI Decisions 做固定选项分类或评分；它不是首个闭环的前置依赖。
- **Independent evaluation**：金额、journal、重复 effect 用精确断言；解释质量、证据相关性可用独立 model judge 辅助。Judge 不负责运行时审批，也不把 synthetic labels 变成人工审计结果。

应用已有的 `/api/invoice-mvp/decisions` 是业务 review endpoint，不代表已经接入 OpenAI Decisions。

OpenAI 官方当前说明 Decisions 返回 predicate/choice/score，当前只支持 `gpt-6-luna`；需要自定义对象、解释或 tool calls 时使用 Responses 的相应能力。是否采用 Decisions 由固定数据上的准确性和 latency 验证决定，不因为它便宜就替换高质量推理路径。来源：[Decisions](https://developers.openai.com/api/docs/guides/decisions)、[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)。

## Data 起点

使用现有 Golden State world + stateful FakeBank。先补可上传 PDF、PO/receipt 文件关系、reviewed expected outcomes 和 bridge。外部 document dataset 通常不能同时提供公司政策、授权状态、银行状态变化和独立正确答案。Synthetic 可以形成闭环，但必须标明来源，保留独立 reviewer 的真实身份和评审状态。

## 文件

- `LAUNCH.md`：可复制的单一 Master `/goal` 指令、角色分工和调度方式。
- `MASTER.md`：总协调者执行规则。
- `WORKSTREAMS.md`：四个 owner 的任务与交付标准。
- `plan.json`：依赖图、初始状态与 evidence 字段。
- `API-READINESS.md`：当前凭证与运行条件核查。
- `LLAMAPARSE-SMOKE.md`：首轮 PDF/TIFF parsing、字段与 grounding 的成功项和失败项。
- `LLAMAPARSE-CONTROLS.md`：正常 PDF、真实扫描件的对照实测和剩余 grounding 缺口。
- `LLAMAPARSE-GROUNDING.md`：raw words 配置复测、Tesseract fallback 实证及 `/goal` 启动边界。
- `check-environment.mjs`：不显示密钥的配置检查；`--online` 只读检查，`--smoke` 另加一次最小模型调用。
- `providers.env.example`：无密钥模板；实际配置在 Git 忽略的 `var/ap-environment/providers.env`。
- `issue-97.snapshot.md`：已同步 fallback 更新的 issue；启动时比较 live issue 后记录采用版本。
- `issue-97.snapshot.meta.json`：issue 更新时间、snapshot SHA256 和字节数。
- `codex-config.toml.example`：可选项目配置样例，**未安装**，不覆盖用户现有设置。

模型默认继承用户当前设置；没有为省成本降档。Codex 登录与应用运行时 OpenAI API key 是两个不同配置。

来源：[官方 /goal 文档](https://learn.chatgpt.com/docs/developer-commands?surface=cli)、[官方 subagents 文档](https://learn.chatgpt.com/docs/agent-configuration/subagents)、[issue #97](https://github.com/srivatsav-kannan/autonomous-finance/issues/97)。
