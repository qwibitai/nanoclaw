# Change: Remove /workspace Path Remnants

## Why

`remove-container-isolation` 完成了将 agent 执行从 Docker 容器迁移到 Node.js 子进程的核心工作，但刻意保留了 `/workspace/` 路径回退（task 2.1）以维持容器兼容性。容器层现已完全移除，这些回退永远不会被触发，成为误导性的死代码。同时，`src/mount-security.ts` 等容器专属模块也变成了零依赖的孤立代码。

## What Changes

- 删除 `src/mount-security.ts`（容器挂载验证模块，零上游依赖）
- 从 `src/types.ts` 删除 `AdditionalMount.containerPath` 字段、`MountAllowlist` 接口、`AllowedRoot` 接口（均只被 mount-security.ts 使用）
- 从 `container/agent-runner/src/index.ts` 移除全部 5 处 `/workspace/` 回退默认值（env var 由 process-runner 始终注入，回退永远不触达）
- 更新 `src/config.ts` 注释（去掉对已删除的 `container-runner.ts` 的引用）
- 删除 `.claude/skills/add-gmail/modify/src/container-runner.ts`（安装时会写入死文件）
- 删除 `.claude/skills/add-ollama-tool/modify/src/container-runner.ts`（安装时会写入死文件）
- 将 `.claude/skills/add-image-vision/modify/src/container-runner.ts` 替换为 `modify/src/process-runner.ts`（`imageAttachments` 字段需打补丁到新位置）
- 同步更新上述 skill 的 `modify/container/agent-runner/src/index.ts`：去掉其中的 `/workspace/` 回退
- 更新 `openspec/project.md`：移除容器隔离相关描述，反映 process-runner 架构现实

## Impact

- Affected specs: `agent-execution`（MODIFIED）
- Affected code:
  - `src/mount-security.ts` → 删除
  - `src/types.ts` → 移除容器专属字段和接口
  - `container/agent-runner/src/index.ts` → 移除 `/workspace/` fallback
  - `src/config.ts` → 更新注释
  - `.claude/skills/add-gmail/modify/src/container-runner.ts` → 删除
  - `.claude/skills/add-gmail/modify/src/container-runner.ts.intent.md` → 删除
  - `.claude/skills/add-ollama-tool/modify/src/container-runner.ts` → 删除
  - `.claude/skills/add-ollama-tool/modify/src/container-runner.ts.intent.md` → 删除
  - `.claude/skills/add-image-vision/modify/src/container-runner.ts` → 替换为 process-runner.ts
  - `.claude/skills/add-image-vision/modify/src/container-runner.ts.intent.md` → 替换为 process-runner.ts.intent.md
  - `openspec/project.md` → 架构描述更新
