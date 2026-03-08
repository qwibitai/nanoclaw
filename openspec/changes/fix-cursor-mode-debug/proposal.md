# Change: Fix Cursor Mode Debug Visibility and Redundant Output

## Why

当 `.env` 设置 `AGENT_BACKEND=cursor` 后发消息无回复时，用户难以判断：backend 是否正确传递、agent-runner 是否实际使用 cursor-runner、还是 agent 子进程本身出问题。此外，`cursor-runner.ts` 在每轮 query 结束后额外调用 `writeOutput({ result: null })`，与 `handleEvent` 中已发送的 `assistant`/`result` 事件重复，增加噪音且无实际语义。

## What Changes

- **process-runner.ts**：在 `LOG_LEVEL=debug` 时的环境配置日志中增加 `agentBackend` 字段，便于确认传入的 `AGENT_BACKEND` 值
- **agent-runner index.ts**：启动时向 stderr 打印 `[agent-runner] AGENT_BACKEND=<value>`，使 process log 中可明确看到实际选用的 backend
- **cursor-runner.ts**：移除每轮 spawn 完成后、`waitForIpcMessage` 之前的冗余 `writeOutput({ status: 'success', result: null, newSessionId })`；`handleEvent` 已在 `assistant`/`result` 事件中发送有效输出，session 更新由 host 的 `wrappedOnOutput` 处理
- **debug skill**：新增「Cursor 模式无反馈」排查条目，含 backend 验证、PATH 检查、手动测试命令；认证由 agent 的 `agent login` 负责，不要求 `CURSOR_API_KEY`

## Impact

- Affected specs: `agent-execution`（MODIFIED: 调试可见性；cursor-runner 输出语义）, `debug-skill`（ADDED: Cursor 模式排查）
- Affected code:
  - `src/process-runner.ts` — +1 字段于 debug 日志
  - `container/agent-runner/src/index.ts` — +1 行 stderr 输出
  - `container/agent-runner/src/cursor-runner.ts` — 移除 1 行
  - `.claude/skills/debug/SKILL.md` — 新增 Cursor 模式排查段落
