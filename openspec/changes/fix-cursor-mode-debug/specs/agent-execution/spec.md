# Capability: agent-execution

## ADDED Requirements

### Requirement: Agent Backend Debug Visibility

系统 SHALL 在 agent 执行流程中提供可观测的 backend 选择信息，便于排查 `AGENT_BACKEND=cursor` 配置是否生效。

`src/process-runner.ts` 在 `LOG_LEVEL=debug` 时的环境配置日志中 SHALL 包含 `agentBackend` 字段，值为 `buildEnv()` 传入的 `AGENT_BACKEND`。

`container/agent-runner/src/index.ts` 在 backend 分支判断之前 SHALL 向 stderr 输出 `[agent-runner] AGENT_BACKEND=<value>`，使 `groups/{folder}/logs/process-*.log` 中可明确看到实际选用的 runner。

#### Scenario: 用户排查 cursor 模式是否生效

- **WHEN** 用户设置 `AGENT_BACKEND=cursor` 且发消息无回复
- **THEN** 用户可查看 process log 的 Stderr 部分，若看到 `[agent-runner] AGENT_BACKEND=cursor` 则确认 backend 已正确传递
- **AND** 用户可设置 `LOG_LEVEL=debug` 查看主日志中的 `agentBackend` 字段

#### Scenario: claude 模式下日志无误导

- **WHEN** `AGENT_BACKEND` 未设置或为 `claude`
- **THEN** stderr 输出 `[agent-runner] AGENT_BACKEND=claude`
- **AND** 行为与修改前一致

---

### Requirement: Cursor Runner Output Semantics

`cursor-runner.ts` 的 `writeOutput` 调用 SHALL 仅在 `handleEvent` 处理 `assistant` 或 `result` 事件时发生，用于向 host 发送实际 agent 输出或错误。

`cursor-runner.ts` SHALL NOT 在每轮 spawn 完成后、`waitForIpcMessage` 之前调用 `writeOutput({ status: 'success', result: null, newSessionId })`。session 更新由 host 的 `wrappedOnOutput` 在收到含 `newSessionId` 的输出时处理。

#### Scenario: 有效输出仅来自 handleEvent

- **WHEN** Cursor agent 产生 `assistant` 或 `result` 事件
- **THEN** `handleEvent` 调用 `writeOutput` 传递文本或错误
- **AND** host 的 onOutput 回调据此发送消息给用户

#### Scenario: 每轮结束无冗余 writeOutput

- **WHEN** `spawnAgent` resolve 且本轮无 `assistant`/`result` 内容
- **THEN** `cursor-runner` 不调用 `writeOutput`，直接进入 `waitForIpcMessage`
- **AND** sessionId 已由之前 handleEvent 中的 `newSessionId` 传递并更新
