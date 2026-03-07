# Capability: agent-context

Agent 上下文文件——agent 在每次会话启动时读取的环境描述文件，指引 agent 了解自身所处环境、可用路径和操作方式。

## ADDED Requirements

### Requirement: Process-Based Path References

Agent 上下文文件（`groups/*/CLAUDE.md`）中的路径引用 SHALL 使用进程执行模型下的真实路径，不得使用 Docker 容器挂载路径（`/workspace/...`）。

Agent 执行时的路径约定：
- **工作目录（cwd）**：`groups/{folder}/`（绝对路径，即 group folder）
- **项目根目录**：cwd 上两级（`../..`）
- **IPC 目录**：`$NANOCLAW_IPC_DIR`（环境变量，绝对路径）
- **额外目录**：`$NANOCLAW_EXTRA_DIR`（环境变量，绝对路径，仅主群组且配置了 `additionalMounts` 时设置）

#### Scenario: Agent 查找 IPC 文件

- **WHEN** agent 需要读取 `available_groups.json`
- **THEN** agent 使用 `$NANOCLAW_IPC_DIR/available_groups.json`，而非 `/workspace/ipc/available_groups.json`

#### Scenario: Agent 操作项目数据库

- **WHEN** agent 需要直接查询 SQLite 数据库
- **THEN** agent 使用 `../../store/messages.db`（相对于 cwd），而非 `/workspace/project/store/messages.db`

#### Scenario: Agent 写入 IPC 任务

- **WHEN** agent 需要发送 IPC 指令（如 refresh_groups）
- **THEN** agent 使用 `$NANOCLAW_IPC_DIR/tasks/` 路径，而非 `/workspace/ipc/tasks/`

### Requirement: Additional Directory Configuration

`containerConfig.additionalMounts` 示例 SHALL 仅包含 `hostPath` 和可选的 `readonly` 字段，不得包含已废弃的 `containerPath` 字段。

额外目录通过 `NANOCLAW_EXTRA_DIR` 环境变量传递给 agent-runner，而非挂载到 `/workspace/extra/{name}`。

#### Scenario: 配置额外目录

- **WHEN** 用户为群组配置 `additionalMounts`
- **THEN** 配置示例仅展示 `hostPath` 和 `readonly` 字段
- **AND** 说明该目录通过 `$NANOCLAW_EXTRA_DIR` 环境变量访问（而非 `/workspace/extra/...`）
