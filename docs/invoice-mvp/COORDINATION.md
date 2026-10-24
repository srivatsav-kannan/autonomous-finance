# Orchestration record

Owner: root chat `01a16fb4-0204-7780-9d59-1a5d60c4791c`, local host.

Repository verified: `/Users/junjiexiong/Desktop/calhacks` remote is `srivatsav-kannan/autonomous-finance`; main at `adbe32c8b1d9fd5ba426b43ba5b5d1e52e58f1e8`. Untracked `artifacts/` preserved. No applicable AGENTS.md found. Node v24.22.0. Configured Codex model settings retained (no overrides). No API credentials or explicit spend budget discovered in this environment. Track brief read via Google Drive; emphasizes narrow seats, conflicting sources, durable recovery, permissions and evidence.

PR status refreshed 2026-10-24: #51 OPEN head `951b2df51fccbb3c380eb84abff08b4b1aee068a`; #47 OPEN `3d762d496faa2b3cdd841c26133439c00dd397a7`; #48 OPEN `d1fbfc2d693514d99b153d49691c53f6d2d63c7f`; #49 OPEN `70d6723b5431b3e004eb9b82326f581ae614d75d`; #50 OPEN `f6cd52431b959630b3d483ef167a9f464ed15438`. #47 -> #49 -> #50 is bank/AP stack. #48 overlaps its legacy payments work. Banking stays out of critical path; do not combine competing implementations.

Integration worktree: `/Users/junjiexiong/.codex/worktrees/invoice-mvp-integration/calhacks`, branch `codex/invoice-mvp-integration`. Upstream reuse base: #51 exact head above. Common worker base: contract bootstrap commit (record next). Contract owner A; changes require root approval. At most 3 active worker chats, 4 total. Launch A/B/D; C follows when a slot opens. Workers must use native create_goal and provide evidence of activation.

Integration status: contract established; implementation pending. Required final evidence is all eleven acceptance checks on one integrated source commit. Live-model validation is a distinct external dependency, not inferred from free tests. Root owns final review, integration, startup, browser acceptance, README/architecture and draft PR.

## Workers

Pending dispatch. Handoffs must include native goal status, chat/host, worktree/branch/base, commit, owned files, commands+results, tests not run, exact blockers, and contract changes. Worker confidence is not acceptance.
