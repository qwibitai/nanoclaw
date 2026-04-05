# local-runner

## ADDED Requirements

### Requirement: R1 Git Tag 保留 Docker 快照
系统 MUST 在改造前打 git tag 保留 Docker 方案的完整代码快照。

#### Scenario: S1.1 打标
- GIVEN 当前代码仍使用 Docker 容器运行 agent
- WHEN 开始 local-runner 改造
- THEN 先在当前 commit 上打 tag `docker-runtime-v1`
- AND push tag 到远程仓库

### Requirement: R2 本地进程 Spawn
系统 MUST 使用 `child_process.spawn` 以 Node.js 子进程方式运行 agent-runner，替换 Docker 容器方式。

#### Scenario: S2.1 正常执行
- GIVEN NanoClaw 收到用户消息
- WHEN 触发 agent
- THEN spawn `node container/agent-runner/dist/index.js` 子进程
- AND stdin 写入 ContainerInput JSON（含 workspacePaths）
- AND stdout 通过 `OUTPUT_START_MARKER`/`OUTPUT_END_MARKER` 协议解析输出
- AND 回复正确路由到用户

#### Scenario: S2.2 子进程异常退出
- GIVEN agent 子进程运行中
- WHEN 子进程非正常退出（exit code != 0）
- THEN 宿主进程记录错误日志
- AND 不 hang、不 crash

#### Scenario: S2.3 子进程 hang 住超时强杀
- GIVEN agent 子进程运行中
- WHEN 子进程超过 timeout 时间未输出 OUTPUT_MARKER（timeout 从启动或上次输出时重置）
- THEN 发送 SIGTERM 信号
- AND 等待 5 秒宽限期
- AND 若仍未退出则发送 SIGKILL
- AND 清理进程组（包括 MCP server、浏览器等孙进程）

#### Scenario: S2.4 dist/index.js 不存在
- GIVEN `container/agent-runner/dist/index.js` 不存在
- WHEN 用户发送消息触发 agent
- THEN 日志输出明确错误：`agent-runner 未编译，请运行 npm run build:agent`
- AND 向用户回复错误提示

#### Scenario: S2.5 多群组并发
- GIVEN 同时有两个群收到消息
- WHEN 两个 agent 子进程同时运行
- THEN 各自使用独立的 IPC 目录、group 目录和 .claude 配置目录，互不干扰

### Requirement: R3 路径映射
agent-runner MUST 通过 `ContainerInput.workspacePaths` 接收工作目录的真实路径。

#### Scenario: S3.1 真实路径传入
- GIVEN 宿主进程构建 ContainerInput
- WHEN 写入 stdin
- THEN 包含 workspacePaths（必传: group、ipc；可选: project、global、extra）
- AND agent-runner 使用这些路径读写文件
- AND CLAUDE.md、IPC 消息、对话归档等功能正常

#### Scenario: S3.2 ipc-mcp-stdio.ts 路径配置
- GIVEN agent SDK 启动 MCP server 子进程
- WHEN ipc-mcp-stdio.ts 启动
- THEN 从环境变量 `NANOCLAW_IPC_DIR` 读取 IPC 目录路径
- AND `NANOCLAW_IPC_DIR` 通过 agent-runner 的 `mcpServers.nanoclaw.env` 配置显式传递（SDK 不自动继承父进程完整 env）

### Requirement: R4 凭证注入
系统 MUST 正确注入 API key 和 token 到子进程环境变量。

#### Scenario: S4.1 API key 注入（OneCLI 可用）
- GIVEN OneCLI 已安装
- WHEN 启动 agent 子进程
- THEN 通过 `onecli agents get-env --id <agent>` 获取 ANTHROPIC_API_KEY
- AND 注入到子进程 env

#### Scenario: S4.2 API key 注入（OneCLI 不可用 fallback）
- GIVEN OneCLI 未安装或命令失败
- WHEN 启动 agent 子进程
- THEN fallback 到 `process.env.ANTHROPIC_API_KEY`
- AND 再 fallback 到 `.env` 文件读取

#### Scenario: S4.3 非 main 群组凭证区分
- GIVEN 当前群组不是 main group
- WHEN 启动 agent 子进程
- THEN 使用群组对应的 OneCLI agent identifier 获取凭证

#### Scenario: S4.4 GitHub token 和 SSH 继承
- GIVEN 宿主进程有 `GH_TOKEN`/`GITHUB_TOKEN`、`SSH_AUTH_SOCK`、`SSH_AGENT_PID`
- WHEN 启动 agent 子进程
- THEN 这些变量透传给子进程

#### Scenario: S4.5 飞书 token 注入
- GIVEN 消息来自飞书渠道
- WHEN 启动 agent 子进程
- THEN `FEISHU_TENANT_TOKEN` 注入到子进程 env

### Requirement: R5 Per-group .claude 配置隔离
系统 MUST 为每个群组维护独立的 `.claude/` 配置目录。

#### Scenario: S5.1 per-group settings.json
- GIVEN 启动 agent 子进程
- WHEN 子进程启动
- THEN env 中 `CLAUDE_CONFIG_DIR` 指向 `data/sessions/{group_folder}/.claude`
- AND settings.json 包含 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1'` 等配置

#### Scenario: S5.2 skills 同步
- GIVEN 启动 agent 子进程
- WHEN 子进程启动前
- THEN `container/skills/` 目录下的 skills 已同步到对应的 per-group `.claude/skills/` 目录

#### Scenario: S5.3 不同群组隔离
- GIVEN 群组 A 和群组 B 各自运行 agent
- WHEN 群组 A 的 agent 写入 session 数据
- THEN 群组 B 的 `.claude/` 目录不受影响

### Requirement: R6 构建体验
系统 MUST 支持通过 `npm run build:agent` 编译 agent-runner，无需 Docker。

#### Scenario: S6.1 修改后重建
- GIVEN 开发者修改了 `container/agent-runner/src/index.ts`
- WHEN 运行 `npm run build:agent`
- THEN TypeScript 编译完成（通常 < 3 秒）
- AND 下次 agent 启动使用新代码

### Requirement: R7 安全与限制声明
系统 MUST 在文档中明确标注安全边界和功能限制。

#### Scenario: S7.1 文件系统无沙箱
- GIVEN agent 子进程运行中
- WHEN agent 使用 Bash/Read/Write 等工具
- THEN 子进程可访问宿主文件系统（含 project 目录可写、`.env` 可读，无操作系统级沙箱）
- AND 此行为在文档中明确标注（Docker 模式下 `.env` 被 `/dev/null` shadow mount 遮蔽，local 模式无此保护）

#### Scenario: S7.2 不支持 per-group agent-runner 定制
- GIVEN 多个群组运行 agent
- WHEN 所有群组触发 agent
- THEN 共享同一份编译后的 agent-runner 代码
- AND 此限制在文档中明确标注

### Requirement: R8 移除 Docker 依赖
系统 MUST 移除对 Docker 运行时的依赖。

#### Scenario: S8.1 无 Docker 环境正常启动
- GIVEN Docker 未安装
- WHEN NanoClaw 启动
- THEN 正常启动，不报错
- AND 不调用任何 Docker 相关检查
