# AP system — current status and handoff

当前 USD 合成沙盒流程与本地银行对账已通过。**先看 [CURRENT-STATUS.md](CURRENT-STATUS.md)**：它区分 PR #106 的已完成修复、完整 issue #97 的剩余范围和外部评审状态。

| 文件 | 用途 |
| --- | --- |
| [当前状态](CURRENT-STATUS.md) | 实测结果、三笔分录、交付边界、剩余事项和运行来源 |
| [新 AP case agent](AP-CASE-AGENT.md) | 缺证等待、恢复、自动付款提案、独立授权边界及运行说明 |
| [#97 差距表](ISSUE-97-GAP-MAP.md) | 原 roadmap 与最新 agent 能力矩阵的证据/缺口 |
| [plan.json](plan.json) / [CAPABILITIES.md](CAPABILITIES.md) | 机器可读登记表与详细能力记录 |
| [Claude 独立模型评审](CLAUDE-REVIEW.md) | 原件/政策先行的两阶段评审，发现、修复和复核记录 |
| [付款与 QBO 实测](evidence/C4-live-happy-path.md) | Auth0 → Bill → Increase → BillPayment 的真实 sandbox 记录 |
| [测试入金对账](evidence/C4-funding-reconciliation.md) | 两条流水已匹配、现金账一致、零重复写入 |
| [Auth0](AUTH0-SETUP.md) / [QuickBooks](QUICKBOOKS-SETUP.md) / [API readiness](API-READINESS.md) | 已配置环境及复建说明，凭证保持 server-only |
| [I3 runbook](I3-RUNBOOK.md) | 同一 case 的缺证到达、进程中断与恢复演示 |

本轮使用 USD、笔记本网页和合成原件；CI、多币种、额外手机适配和托管延后。外部接收者执行 Claude 独立模型评审；真人 practitioner 不再阻塞本轮交付，尚未收到 Claude 结果。

`LAUNCH.md`、`MASTER.md`、`WORKSTREAMS.md`、冻结的 `issue-97.snapshot.*` 及早期 parser/checkpoint 报告是历史启动/验证材料，不能用其中的“尚未启动”或“等待付款”判断当前状态。原始报告和 Claude 冻结包按其版本保留；补充实测记录单独打包。随后用户授权的新 AP case agent 已完成窄范围本地实现与验证；完整 goal、CI、production 部署和新增外部付款不在本轮执行范围。
