# Capability: agent-execution (delta)

## MODIFIED Requirements

### Requirement: Environment Variable Path Resolution

系统 SHALL 通过 `NANOCLAW_*` 环境变量向 agent-runner 子进程传递工作路径，替代原容器 volume mount 机制。

所需环境变量：

| 变量 | 值 | 说明 |
|------|----|------|
| `NANOCLAW_GROUP_DIR` | `resolveGroupFolderPath(group.folder)` | 群组工作目录 |
| `NANOCLAW_IPC_DIR` | `resolveGroupIpcPath(group.folder)` | IPC 文件目录 |
| `NANOCLAW_GLOBAL_DIR` | `path.join(GROUPS_DIR, 'global')` | 全局 CLAUDE.md 目录 |
| `NANOCLAW_EXTRA_DIR` | 第一个 `additionalMounts` 条目（如有） | 附加挂载目录 |
| `HOME` | `path.join(DATA_DIR, 'sessions', group.folder)` | Claude 会话数据目录 |
| `TZ` | `TIMEZONE` 配置值 | 时区 |

agent-runner 的路径解析 SHALL 直接使用上述环境变量，不保留 `/workspace/` 路径回退。`process-runner.ts` 始终注入全部所需变量，agent-runner 不应在缺少这些变量时静默回退到无效路径。

#### Scenario: 子进程接收正确路径

- **WHEN** 系统启动 agent-runner 子进程
- **THEN** 子进程环境中包含所有 `NANOCLAW_*` 变量和 `HOME`、`TZ`
- **AND** `NANOCLAW_GROUP_DIR` 指向宿主上该群组的真实绝对路径

#### Scenario: 缺少环境变量时行为确定

- **WHEN** agent-runner 启动时缺少 `NANOCLAW_IPC_DIR` 等必需变量
- **THEN** agent-runner 使用缺失值（undefined）而非回退到 `/workspace/` 路径
- **AND** 路径错误会产生可观察的错误，而非静默使用错误路径

## REMOVED Requirements

### Requirement: Mount Security Validation

**Reason**: `src/mount-security.ts` 是容器专属模块，负责验证 Docker volume mount 路径。容器层移除后，该模块无任何调用方，已成为零依赖死代码。`AdditionalMount.hostPath` 仍被 `process-runner.ts` 用于设置 `NANOCLAW_EXTRA_DIR`，但不再需要挂载白名单验证。

**Migration**: 无需迁移。附加目录通过 `NANOCLAW_EXTRA_DIR` 环境变量直接传递，访问控制由 Claude Agent SDK 权限模型负责。

#### Scenario: 附加目录直接传递（已移除场景）

- **WHEN** 群组配置中指定了 `additionalMounts[0].hostPath`
- **THEN** process-runner 将其设为 `NANOCLAW_EXTRA_DIR`，不执行白名单验证
