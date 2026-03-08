## 1. 预创建 debug 目录

- [x] 1.1 在 `src/process-runner.ts` 的 `prepareGroupDirs()` 函数末尾，追加：
  ```ts
  const claudeDebugDir = path.join(homeDir, '.claude', 'debug');
  fs.mkdirSync(claudeDebugDir, { recursive: true });
  ```
  其中 `homeDir = path.join(DATA_DIR, 'sessions', group.folder)`

## 2. 屏蔽错误输出中的 session ID

- [x] 2.1 在 `src/index.ts` `runAgent()` 的 `wrappedOnOutput` 回调中，将：
  ```ts
  if (output.newSessionId) {
  ```
  改为：
  ```ts
  if (output.newSessionId && output.status !== 'error') {
  ```

## 3. 验证

- [x] 3.1 运行 `npm run build` 确认编译无误
- [ ] 3.2 手动测试：删除 `data/sessions/test/.claude/debug/`，发送消息，确认 session 正常启动
- [ ] 3.3 手动测试：模拟 agent 崩溃后返回错误 session ID，确认 DB 中不写入该 ID
