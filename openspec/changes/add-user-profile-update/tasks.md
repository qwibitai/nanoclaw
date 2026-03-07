## 1. 初始化 USER.md 模板内容

- [x] 1.1 将 `groups/main/USER.md` 替换为结构化初始模板

## 2. 代码层自动创建

- [x] 2.1 在 `src/process-runner.ts` 的 `prepareGroupDirs()` 中，当 `isMain` 为 true 且群组目录下无 `USER.md` 时，用模板内容创建该文件（`writeFileIfMissing` 语义：只写不覆盖）
