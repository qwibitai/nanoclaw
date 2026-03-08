# Tasks: Fix Cursor Mode Debug Visibility

## 1. Process Runner Debug Logging

- [x] 1.1 在 `src/process-runner.ts` 的 `logger.debug` 环境配置对象中增加 `agentBackend: env.AGENT_BACKEND`

## 2. Agent Runner Startup Logging

- [x] 2.1 在 `container/agent-runner/src/index.ts` 中，backend 分支判断之前，增加 `console.error(\`[agent-runner] AGENT_BACKEND=${backend}\`)`

## 3. Cursor Runner Redundant Output

- [x] 3.1 在 `container/agent-runner/src/cursor-runner.ts` 的 while 循环内，删除 spawnAgent 返回后、waitForIpcMessage 之前的 `writeOutput({ status: 'success', result: null, newSessionId: sessionId })`

## 4. Debug Skill Cursor Troubleshooting

- [x] 4.1 在 `.claude/skills/debug/SKILL.md` 的「MCP Server Failures」之后、「Manual Process Testing」之前，新增「### 4. Cursor 模式无反馈」小节
- [x] 4.2 小节内容包含：backend 验证、agent CLI PATH 验证、`LOG_LEVEL=debug` 建议、手动测试 cursor-runner 的命令（含 `AGENT_BACKEND=cursor` 环境变量）
- [x] 4.3 不要求或提及 `CURSOR_API_KEY`，说明认证由 agent 自身（`agent login`）负责
