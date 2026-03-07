# Change: Add TOOLS.md Workspace File

## Why

参考 openclaw 的 `TOOLS.md` 机制：提供一个专门存放本地环境特有配置的文件（摄像头名称、SSH 主机、设备别名等），与可共享的 Skills 分离。Skills 定义工具的使用方式，TOOLS.md 记录用户特有的环境信息。目前 nanoclaw-office 没有此文件，agent 无法感知用户本地环境配置。

## What Changes

- `src/process-runner.ts` — 在 `prepareGroupDirs()` 中，main group 首次运行时若 `TOOLS.md` 不存在则自动创建（`writeFileIfMissing` 语义）
- `container/agent-runner/src/index.ts` — 读取 group 目录下的 `TOOLS.md`（如存在），与 IDENTITY.md、BOOTSTRAP.md 一同注入 system prompt
- `groups/main/TOOLS.md` — 立即创建，填入 openclaw 原版模板内容

## Impact

- Affected specs: `agent-workspace`（新建）
- Affected code: `src/process-runner.ts`、`container/agent-runner/src/index.ts`、`groups/main/TOOLS.md`
