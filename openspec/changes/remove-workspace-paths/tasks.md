# Tasks: Remove /workspace Path Remnants

按顺序完成，每步独立可验证。

## 1. 删除死代码模块

- [x] 1.1 删除 `src/mount-security.ts`
- [x] 1.2 删除 `src/types.ts` 中的 `AdditionalMount.containerPath` 字段
- [x] 1.3 删除 `src/types.ts` 中的 `MountAllowlist` 接口和 `AllowedRoot` 接口
- [x] 1.4 验证：`npx tsc --noEmit` 零错误

## 2. 清理 agent-runner /workspace 回退

- [x] 2.1 修改 `container/agent-runner/src/index.ts`：删除 5 处 `?? '/workspace/...'` 回退默认值，改为直接读取 env var（不存在则抛出或使用 process.cwd() 作为最后回退）
- [x] 2.2 验证：`npm run build` 成功，`container/agent-runner/dist/index.js` 正常生成

## 3. 更新注释

- [x] 3.1 修改 `src/config.ts` 第 9 行注释：去掉对 `container-runner.ts` 的引用
- [x] 3.2 修改 `src/types.ts`：清理所有 `/workspace` 相关注释残留

## 4. 更新 Skill 模板文件

- [x] 4.1 删除 `.claude/skills/add-gmail/modify/src/container-runner.ts` 和其 `.intent.md`
- [x] 4.2 删除 `.claude/skills/add-ollama-tool/modify/src/container-runner.ts` 和其 `.intent.md`
- [x] 4.3 在 `.claude/skills/add-image-vision/modify/src/` 新建 `process-runner.ts`（将 `imageAttachments` 字段补丁打到 `ContainerInput` 接口）
- [x] 4.4 新建对应的 `process-runner.ts.intent.md`，说明变更意图
- [x] 4.5 删除 `.claude/skills/add-image-vision/modify/src/container-runner.ts` 和其 `.intent.md`
- [x] 4.6 同步更新 3 个 skill 下的 `modify/container/agent-runner/src/index.ts`：去掉 `/workspace/` 回退

## 5. 更新 project.md

- [x] 5.1 修改 `openspec/project.md`：
  - Container Runtime 从 Docker/Apple Container 改为 "Node.js 子进程（直接执行 `container/agent-runner/dist/index.js`）"
  - 移除架构模式中的"容器隔离"描述，更新为"进程隔离"
  - 更新 Important Constraints 中的挂载安全描述
  - 移除 External Dependencies 中的 Docker/Apple Container 条目

## 6. 最终验证

- [x] 6.1 `npx tsc --noEmit` 零错误
- [x] 6.2 `npm test` 全部通过（feishu 2 个测试失败为预存在问题，与本次变更无关）
