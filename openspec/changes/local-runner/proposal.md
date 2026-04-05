## Why

NanoClaw 当前通过 Docker 容器运行 agent（Claude Code SDK）。Docker 带来了隔离性，但也引入了显著限制：

- **构建慢**: 每次修改 agent-runner 都需要重建镜像（1-3 分钟）
- **调试难**: 容器内日志和文件系统隔离，排查问题不便
- **路径受限**: 容器只能访问预定义的 volume mount，无法灵活读写宿主文件
- **凭证注入复杂**: OneCLI 需要拦截容器网络流量注入 API key
- **资源开销**: Docker Desktop 常驻内存 ~2GB
- **macOS 兼容性**: Apple Silicon 上 Docker 偶发性能问题

对于个人使用场景，隔离性的收益不足以抵消以上成本。直接用 Node.js 子进程替换 Docker 容器。

## What Changes

- **改造前先打 git tag**（如 `docker-runtime-v1`），保留 Docker 方案的完整快照以备回退
- 移除 Docker spawn 逻辑，改为 `child_process.spawn('node', [...])` 直接运行 agent-runner
- agent-runner 中所有 `/workspace/*` 硬编码路径（index.ts 5 处独立 + 1 处派生 + ipc-mcp-stdio.ts 1 处）改为从 `ContainerInput.workspacePaths` 读取
- agent-runner 中 `/tmp/input.json` 清理代码移除（Docker entrypoint 遗留）
- `ipc-mcp-stdio.ts` 通过环境变量 `NANOCLAW_IPC_DIR` 接收 IPC 路径（需在 mcpServers.nanoclaw.env 显式传递）
- per-group `.claude/` sessions 目录通过 `CLAUDE_CONFIG_DIR` 环境变量指向隔离路径
- 凭证注入改用 OneCLI CLI 模式或直接 .env 读取
- 飞书 token 获取逻辑增强：新增 User Token 优先获取（通过 feishu-oauth），fallback 到 Tenant Token（原有逻辑）
- 移除 `ensureContainerSystemRunning()`（不再需要 Docker 检查）
- 移除 Docker 相关代码：`container-runtime.ts`、`buildContainerArgs()`、volume mount 构建、`@onecli-sh/sdk` import（改用 CLI 模式）
- 移除 per-group agent-runner 源码拷贝机制
- 移除 `mount-security.ts`（Docker 挂载安全验证，local 模式不适用）
- 删除 `container/Dockerfile`、`container/build.sh`（git tag 中保留）（local 模式所有群共享同一份编译后代码）

## Capabilities

### New Capabilities
- `local-runner`: 以 Node.js 子进程运行 agent，无需 Docker。包含：进程 spawn、路径映射、环境变量注入、stdin/stdout 协议复用、per-group sessions 隔离、子进程信号处理。

### Removed Capabilities
- `docker-runner`: Docker 容器 spawn 逻辑（通过 git tag `docker-runtime-v1` 保留完整代码快照）
- `per-group-agent-customization`: per-group agent-runner 源码拷贝和容器内重编译

## Impact

- **src/container-runner.ts**: 移除 Docker spawn / `buildContainerArgs()` / `buildVolumeMounts()` / `@onecli-sh/sdk` 引用；新增 `getFeishuToken()`、`parseEnvOutput()` 辅助函数
- **src/container-runtime.ts**: 删除
- **src/mount-security.ts**: 删除
- **src/index.ts**: 移除 `ensureContainerSystemRunning()`
- **src/config.ts**: 移除 `CONTAINER_IMAGE`、`CONTAINER_TIMEOUT`、`CONTAINER_MAX_OUTPUT_SIZE`、`MOUNT_ALLOWLIST_PATH`、`MAX_CONCURRENT_CONTAINERS`；更新注释
- **container/agent-runner/src/index.ts**: 5 处独立 `/workspace/*` 路径改为从配置读取 + `/tmp/input.json` 清理代码移除
- **container/agent-runner/src/ipc-mcp-stdio.ts**: IPC 路径从环境变量读取
- **container/Dockerfile**, **container/build.sh**: 删除（git tag 保留）
- **package.json**: 新增 `build:agent` script
- **依赖**: 移除 `@onecli-sh/sdk`（改用 OneCLI CLI 模式）
