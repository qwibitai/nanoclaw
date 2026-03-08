# Capability: debug-skill

## ADDED Requirements

### Requirement: Cursor Mode Troubleshooting

debug skill SHALL 包含「Cursor 模式无反馈」常见问题排查条目，适用于 `.env` 设置 `AGENT_BACKEND=cursor` 后发消息无回复的场景。

排查步骤须包含：
1. 验证 backend 是否生效：process log Stderr 应有 `[agent-runner] AGENT_BACKEND=cursor`
2. 验证 agent CLI 是否在 PATH 中：launchd plist 的 PATH 为 `~/.local/bin:/usr/local/bin:/usr/bin:/bin`
3. 建议使用 `LOG_LEVEL=debug npm run dev` 观察完整流程

debug skill SHALL 提供手动测试 cursor-runner 的命令，包含 `AGENT_BACKEND=cursor` 环境变量及 `NANOCLAW_*` 路径变量，通过 stdin 传入 `ContainerInput` JSON。

认证由 Cursor agent 的 `agent login` 负责，debug skill 不要求或提及 `CURSOR_API_KEY`。

#### Scenario: 用户排查 cursor 模式无回复

- **WHEN** 用户遇到 `AGENT_BACKEND=cursor` 下无回复
- **THEN** 文档指引查看 process log 中的 `[agent-runner] AGENT_BACKEND=` 以确认 backend
- **AND** 文档指引检查 agent CLI 路径（`which agent`）及 plist PATH
- **AND** 文档不要求配置 `CURSOR_API_KEY`

#### Scenario: 用户手动测试 cursor-runner

- **WHEN** 用户按文档执行手动测试
- **THEN** 命令设置 `AGENT_BACKEND=cursor`、`NANOCLAW_GROUP_DIR`、`NANOCLAW_IPC_DIR`、`NANOCLAW_GLOBAL_DIR`
- **AND** 通过 stdin 传入 JSON 格式的 ContainerInput
- **AND** 若 stderr 出现 `[cursor-runner]` 且 stdout 有 `---NANOCLAW_OUTPUT_START---` 包裹的 JSON，则 runner 正常
