# Tasks: Add TOOLS.md Workspace File

## Task List

- [x] 1.1 在 `src/process-runner.ts` 中定义 `TOOLS_MD_TEMPLATE` 常量（openclaw 原版模板内容）
- [x] 1.2 在 `prepareGroupDirs()` 中添加 main group TOOLS.md 自动创建逻辑（`writeFileIfMissing` 语义）
- [x] 2.1 在 `container/agent-runner/src/index.ts` 中读取 `TOOLS.md`（如存在）
- [x] 2.2 将 `toolsContent` 注入 system prompt 的 append 部分
- [x] 3.1 创建 `groups/main/TOOLS.md` 填入 openclaw 原版模板内容
- [x] 4.1 `npm run build` 编译验证无错误

## Dependencies

- 1.2 依赖 1.1
- 2.2 依赖 2.1
