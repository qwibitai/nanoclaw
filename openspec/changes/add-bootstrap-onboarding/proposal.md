# Change: Add Bootstrap Onboarding for User Profile

## Why

`USER.md` 虽然有结构化模板，但字段全为空——没有机制让 agent 主动收集用户信息。参考 openclaw 的 `BOOTSTRAP.md` 模式：首次启动时若用户档案为空，自动创建一次性引导文件，agent 通过自然对话了解用户，完成后写入 `USER.md` 并删掉引导文件。

## What Changes

- `src/process-runner.ts` — 新增 `isUserProfileEmpty()` 检测函数；在 `prepareGroupDirs()` 中，当 main group 的 USER.md Name 字段为空且 BOOTSTRAP.md 不存在时，自动创建 `BOOTSTRAP.md`
- `groups/main/BOOTSTRAP.md` — 当前不存在，由代码按需生成；内容使用 openclaw 原版模板（自然对话风格，agent 引导用户介绍自己，完成后写 USER.md 并自删）

## Impact

- Affected specs: `user-profile`（ADDED: Bootstrap Onboarding）
- Affected code: `src/process-runner.ts`（`prepareGroupDirs` 函数，新增常量 `BOOTSTRAP_MD_TEMPLATE`）
- Design doc: `docs/plans/2026-03-07-bootstrap-user-profile-design.md`
