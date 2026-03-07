# Change: Add User Profile Auto-Initialization

## Why

`groups/main/USER.md` 目前是空文件。Agent 每次会话都会读取它，但没有任何内容可读，也没有结构供 agent 填充。参考 openclaw 的 `writeFileIfMissing` 模式：在 agent 运行前，若 USER.md 不存在则自动创建带结构的初始模板，agent 即可按模板字段逐步积累用户信息。

## What Changes

- `src/process-runner.ts` — 在 `prepareGroupDirs()` 中，若群组目录下没有 `USER.md`，自动用初始模板创建（仅 main group）
- `groups/main/USER.md` — 填入初始模板内容（当前为空）

## Impact

- Affected specs: `user-profile`（新建）
- Affected code: `src/process-runner.ts`（`prepareGroupDirs` 函数）、`groups/main/USER.md`
