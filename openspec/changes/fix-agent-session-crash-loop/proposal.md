# Change: Fix Agent Session Crash Loop

## Why

Claude Code SDK 在初始化时会向 `$HOME/.claude/debug/` 写入调试文件。若该目录不存在，`appendFileSync` 抛出 `ENOENT`，导致 Node.js 进程崩溃并以 exit code 1 退出。崩溃进程仍会向 stdout 输出一个携带 `newSessionId` 的错误 JSON，宿主进程将其存入 DB，后续所有重试都尝试 resume 这个**从未完整初始化**的 session，每次均以同样方式崩溃，形成无法自愈的死循环，直到手动重启服务。

## What Changes

- `src/process-runner.ts`：在 `prepareGroupDirs()` 中预先创建 `$HOME/.claude/debug/` 目录，确保 SDK 启动时目录已存在
- `src/index.ts`：在 `wrappedOnOutput` 中，仅当 `output.status !== 'error'` 时才将 `newSessionId` 写入 DB，防止崩溃输出中的未初始化 session ID 被持久化

## Impact

- Affected specs: `agent-execution`（ADDED: Agent Debug Directory Pre-creation，ADDED: Session ID Error Output Guard）
- Affected code:
  - `src/process-runner.ts` — `prepareGroupDirs()` 新增 1 行 mkdirSync
  - `src/index.ts` — `wrappedOnOutput` 中 session 更新逻辑增加状态判断

## Root Cause Evidence

调试日志（`logs/nanoclaw.log`，`data/sessions/main/.claude/debug/latest`）揭示完整崩溃链：

1. Session `89f8c75e-...` 正常运行 3 轮后，SDK 尝试写 `data/sessions/main/.claude/debug/b91f33ff-....txt`，目录不存在 → ENOENT
2. 崩溃前 claude-runner 输出 `{"status":"error","newSessionId":"43553a06-..."}` → 宿主存入 DB
3. 后续 5+ 次重试均用 `43553a06-...` resume → 相同崩溃 → 同一 session ID 再次被覆盖写入
4. 手动重启后，DB 无 `main` 条目（重启前写入的 `43553a06-...` 在本次分析时已被后续成功 session 覆盖），系统以全新 session 恢复正常
