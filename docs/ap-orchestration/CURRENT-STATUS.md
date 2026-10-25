# AP 当前交付状态 — 2026-10-25

**当前 USD 沙盒闭环已通过；完整自主 AP roadmap 尚未全部验收。** 本页汇总当前状态，历史报告保留其原始时间和代码版本。完整 roadmap 未整体宣称恢复或完成；用户随后明确启动了新 AP case 的 agent 接入，窄范围实现与本地验证已完成，见 [AP-CASE-AGENT.md](AP-CASE-AGENT.md)。

## 已完成的实际流程

合成原件 INV-1001（Golden State Produce，USD 678.60）完成原件审核、账单批准、本地应付确认、QBO Bill 145 同步、独立 Auth0 用户付款授权、Increase sandbox 付款、结算核对及 QBO BillPayment 146 同步。QBO Bill 余额为 0；只有一笔付款和一笔对应银行扣款。付款执行由 Increase 完成，QBO 只记账。

同一运行的 USD 678.60 测试入金已分类为合成测试资本。本地分录：

| 事项 | 借方 | 贷方 | USD |
| --- | --- | --- | ---: |
| 账单确认 | 5000 费用 | 2000 应付账款 | 678.60 |
| 供应商付款 | 2000 应付账款 | 1000 银行 | 678.60 |
| 测试资本入金 | 1000 银行 | 3000 测试资本 | 678.60 |

共三笔本地分录、两条已匹配银行流水、零未解决对账项；本地现金账和 Increase 当前/可用余额均为 0。重复运行没有新增分录或付款。来源：[付款/QBO 实测](evidence/C4-live-happy-path.md)、[测试入金对账](evidence/C4-funding-reconciliation.md)。使用真实 provider sandbox API、正常 Auth0 登录和官方资金/结算模拟器；单据仍是合成数据。

**边界：**本次完成银行流水与本地账的对账，没有执行正式月结；测试资本分录未导出 QBO，因此没有宣称完成 QBO 银行账户对账。

## #106 和 #97 的区别

| 范围 | 当前结果 | 还需要什么 |
| --- | --- | --- |
| [PR #106](https://github.com/srivatsav-kannan/autonomous-finance/pull/106) | QBO 可选 APAccountRef 响应兼容修复、未知结果只读恢复、ACH 测试入金分类及对账界面均已实现并验证 | 草稿 PR 尚待审核、合并；CI 按用户要求跳过 |
| [Issue #97](https://github.com/srivatsav-kannan/autonomous-finance/issues/97) 的核心 USD 操作流程 | 单据证据、业务控制、账单/分录、独立付款授权、FakeBank 恢复和一笔外部闭环已有证据；PR #105 已合并 | 完整范围还有 agent 接入、自动推进、通信、扩展外测和独立业务模型评审；见[差距表](ISSUE-97-GAP-MAP.md) |

GitHub 的 #97 状态为 CLOSED（更新时间 2026-10-25T11:44:51Z）；这是项目状态，不是全部验收通过的证明。#105 由其他操作者合并到 main（b48885f）；本次没有执行 main 合并。

## 交接和剩余工作

1. **当前沙盒版本交付：**审核/合并 #106，完成一次基于现有记录的桌面演示交接。
2. **Claude 独立模型评审：**外部接收者已有 Claude；按[两阶段评审包](CLAUDE-REVIEW.md)先冻结独立推导，再比较实际结果，保留发现、修复和复核。尚未收到评审结果；不要求真人 practitioner，也不冒称 practitioner sign-off。
3. **新 AP agent：**已实现缺证等待、补证恢复、独立审核后自动付款提案，以及授权后观察原结算并完成本地对账；107 项本地回归通过。独立 human 付款授权保留。当前 5192 live runtime 尚未切换到这版。完整 C01–C30、消息发送/回复和自主业务决策仍不在本轮完成声明内。
4. **更广验收：**外部退回/贷项/连续部分付款、签名 webhook、Auth0 过期/登出等负例及正式关账仍需各自证据；现有本地组件测试不能代替这些外测。真实供应商资料之后再提供。

已明确延后：CI、多币种/FX（[#104](https://github.com/srivatsav-kannan/autonomous-finance/issues/104)）、新增手机适配、网站托管/production。原有全套本地测试结果为其历史版本的 1,886 passed / 4 skipped；#106 两次针对性验证分别为 QBO 49 项和入金 26 项，不能相加冒充新一轮全套测试。前述文档整理没有重跑产品测试；随后 agent 实现另有 107 项本地回归及三个 typecheck 通过，CI 始终未运行。

## 代码和运行来源

- 合并基线：main b48885fcfa3282c31c1123b204055b1be9e9a3a4（PR #105）。
- #106 实现：73979fa（QBO）、28837a9（入金）；后续文档提交不会改变这些测试的代码来源。
- 已验证 Auth0 沙盒运行代码快照：71853508db2bb95d6d87929ab46c79db1d7b2a0f，分支 codex/ap-system-live-auth0。它保留隔离运行基线及这两项修复，不宣称运行了 review 分支的全部功能。
- 运行 ap97-auth0-live-20261025；页面 http://127.0.0.1:5192/ap-system；backend 3252、gateway 8825。端口是已记录配置，不保证进程永远在线。凭证仍只在 Git 忽略的 server-only 私有配置中。
- [机器可读登记表](plan.json)、[详细能力矩阵](CAPABILITIES.md)、[独立评审交接](CLAUDE-REVIEW.md)。
