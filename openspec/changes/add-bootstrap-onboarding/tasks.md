## 1. 实现检测与创建逻辑

- [x] 1.1 在 `src/process-runner.ts` 中新增 `isUserProfileEmpty(groupDir)` 函数：读取 `USER.md`，用正则检测 `- **Name:**` 后是否有值
- [x] 1.2 在 `src/process-runner.ts` 中定义 `BOOTSTRAP_MD_TEMPLATE` 常量（openclaw 原版内容，去掉 frontmatter）
- [x] 1.3 在 `prepareGroupDirs()` 中添加逻辑：`isMain && isUserProfileEmpty` 且 `BOOTSTRAP.md` 不存在时，写入模板
