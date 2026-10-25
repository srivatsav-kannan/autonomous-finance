# 新 AP case 的持久 agent 流程

2026-10-25：本轮完成受控的 USD case 自动推进、缺证等待与恢复；CI 继续跳过。实现采用现有 Convex 业务操作和 agent ControlPlane，使用单独的 account-scoped 队列。旧 `tasks` API 明确拒绝 scoped demo run，因此不绕过其边界，也不把旧场景任务冒充新 AP case。

## 实际行为

1. 正常 `apCases:ingest` 在同一事务中登记一条 `apCaseWork`，重复导入不重复登记。已有 case 可由 AP seat 显式调用 `apCaseAgent:enroll`。
2. AP agent 从后端事实确定下一步，保存缺失项目、责任角色、等待起点和截止时间；原件中的文字不作为 agent 指令。
3. 支持材料以原有上传/显式 revision 流程到达。Worker 重读当前记录，自动恢复同一个 case。审核或银行证据的变化也会触发继续；不依赖一次性通知。
4. 字段审核、账单批准仍按当前公司政策由独立操作人完成。Agent 等待这些决定；不能编造审核、批准或供应商真实性。
5. 当前账单批准并确认应付后，独立 payments seat 调用与网页相同的 `prepareAPCasePayment`。只为没有既往付款历史的受支持 invoice 准备当前余额提案。
6. **付款授权始终由 `apCasePayments:authorize` 的独立 human identity 路径完成。** Agent 工具只有 `inspect_case` 和 `advance_case`，没有授权、切换身份、任意 RPC 或银行调用能力。提案尚未批准时，没有执行命令。
7. 原有付款执行器和银行证据 worker 继续负责已授权 command。AP agent 等待原 command 的结算、分录及匹配状态；只有明确的银行/本地账证据齐全且余额为零才完成。

信用单、取消/退回/拒绝、未知付款结果、已有部分付款及更复杂分摊不触发自动补付。未知在途付款交由现有执行器观察/恢复，其他情况保留 operator resolution。QBO 同步沿用现有独立路径，本轮没有扩大 agent 的外部记账权限。

## 持久性与权限

- 30 秒租约和递增 generation 在每次事务中校验；旧进程、过期租约、外部 account、错误角色和已撤销 seat 均不能推进。
- Claim 使用请求标识；advance 的副作用与任务状态原子提交。响应丢失时重复同一调用返回原结果，不能增加一份付款提案。
- 1 秒 worker loop、5 秒持久重查、每次最多检查 50 个到期 case。重启不清空等待。没有变化的轮询不会制造事件或无限增加空收据。
- 默认等待 24 小时后转交 controller；每个事实版本最多 4 次崩溃接管，每个 case 最多 64 次推进，之后要求操作人显式恢复。这些是运行限制，不改变账单账期或银行付款日期。
- `apCaseAgent:control` 的 pause/resume 只接受原有人类身份，并保留理由、使旧租约失效。它不会批准字段、账单或付款。确定的单-case 后端拒绝会单独升级处理，不阻塞其他 case；未知网络结果保留原操作供恢复。
- `apCaseWorkEvents` 显示在现有网页 **History → Audit timeline**。`apCaseAgent:inspect` 还返回当前责任方、要求和期限。停止 worker 不会删除任务，也不会撤销已经授权的银行 command。

## 运行

在更新了本分支 schema/functions 的既有隔离 local/sandbox backend 上，使用 server-only 私有 JSON：

```json
{
  "convexUrl": "http://127.0.0.1:<owned-backend-port>",
  "scope": {
    "organizationId": "<existing-org>", "runId": "<existing-run>",
    "provider": "fake", "environment": "local", "accountId": "<existing-account>"
  },
  "apCredential": {"seatId": "<existing-ap-seat>", "token": "<private-ap-token>"},
  "paymentsCredential": {"seatId": "<existing-payments-seat>", "token": "<private-payments-token>"}
}
```

配置放在 Git 忽略的 `var/` 下，权限 0600；sandbox 使用其实际 `increase` / `sandbox` scope。复用已配置的两个不同 agent seat，文件不需要 JWT、Auth0 client secret、银行 key、dispatcher token 或 human credentials。

```bash
npm run agents:ap -- --config var/ap-case-agent.private.json
# 单轮检查，不等待未来事件：
npm run agents:ap -- --config var/ap-case-agent.private.json --once
```

正常上传一个缺少 receipt 的 case，查看缺证等待；通过原有 revision 上传 receipt，完成原件/账单审核；agent 将准备付款提案。操作人单独授权之后，由原来的 dispatch/evidence worker 执行和观察；本 worker 不模拟银行结算。SIGTERM/SIGINT 可停止 agent，重新运行同一命令即可恢复。

本轮没有替换现有 5192 Auth0 gateway 或外部 provider 的已验证 runtime，也没有启动新的真实 sandbox 付款。运行时 rollout、真实登录下的新 agent 自动流程外测须单独记录；下述验证不能冒充这些结果。

## 验证与留存

- **107 项本地回归 / 11 个文件通过**，含新功能 15 项；application、backend、tests 三套 TypeScript 检查通过。
- 同一缺证 case：缺 receipt → 补证 revision → 字段审核 → 账单批准 → 自动提案 → 等待独立授权 → FakeBank 结算 → 本地对账完成。实际结果：一账单、一提案、一执行命令、一银行 transfer、两笔分录；重复观察新增分录为零。
- 实际子进程通过 HTTP 使用 CLI：领取任务后 SIGKILL；新进程恢复持久状态，仅产生一提案、零未授权 command。测试 backend 是父进程内的 Convex-test，租约到期由 fixture 调整；不是独立持久数据库进程的重启验证。
- 额外覆盖：事件先于等待、等待阶段不变但缺项变化、响应丢失、竞争领取、过期租约、崩溃预算、超时升级、pause/resume、来源修订、seat 撤销、取消后不自动补付、作用域与工具参数拒绝。
- [实际本地结果](evidence/agent-case-v1/agent-case-flow.json)、[实际进程恢复](evidence/agent-case-v1/agent-process-recovery.json)、[源码/结果哈希与检查记录](evidence/agent-case-v1/manifest.json)。原件是测试文本 stand-in，人工身份模拟，银行是 SQLite FakeBank；没有新 parser、Increase、QBO 或 Claude 外测。

这完成了本轮窄范围 agent 推进能力。完整 C01–C30 registry、自动业务判断/政策委派、真实消息发送/回复、APEX #107 数据回放和更广外部生命周期仍分别待做。Claude 独立模型评审没有被这组工程测试替代。
