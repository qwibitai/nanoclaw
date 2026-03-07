# Project Context

## Purpose

NanoClaw 是一个个人 Claude AI 助手框架，允许通过消息平台（WhatsApp、Telegram、Slack、Discord、Gmail）与 Claude AI 代理交互。核心目标是：将各消息渠道的消息路由到运行在隔离容器（Linux VM）中的 Claude Agent SDK，每个"群组"有独立的文件系统和记忆，实现安全、隔离的 AI 代理执行。

## Tech Stack

- **Runtime**: Node.js >= 20，单进程架构
- **Language**: TypeScript 5.7，ESM 模块（`"type": "module"`），编译目标 ES2022
- **Build**: `tsc`（TypeScript 编译器），开发使用 `tsx` 热重载
- **Database**: SQLite via `better-sqlite3`（存储消息、群组、任务、会话状态）
- **Agent Runner**: Node.js 子进程，直接执行 `container/agent-runner/dist/index.js`，通过 `NANOCLAW_*` 环境变量传递路径
- **AI Agent**: Claude Agent SDK，运行在容器内的 `container/agent-runner/`
- **Scheduling**: `cron-parser` 解析 cron 表达式，支持 cron / interval / once 三种任务类型
- **Validation**: `zod` v4 用于 schema 验证
- **Logging**: `pino` + `pino-pretty`，结构化 JSON 日志
- **Config**: `.env` 文件 + 环境变量，通过 `src/env.ts` 读取
- **Testing**: Vitest（`vitest run` / `vitest`）
- **Formatting**: Prettier，通过 `npm run format` 执行
- **Git Hooks**: Husky

## Project Conventions

### Code Style

- 所有源文件使用 TypeScript，严格模式（`strict: true`）
- ESM 模块风格，import 路径必须带 `.js` 扩展名（即使源文件是 `.ts`）
- 使用 Prettier 格式化，规则在 `.prettierrc` 中定义（如有）
- 函数命名：camelCase；类型/接口：PascalCase；常量：UPPER_SNAKE_CASE
- 文件命名：kebab-case（如 `container-runner.ts`、`group-queue.ts`）
- 测试文件与源文件同目录，命名为 `*.test.ts`
- 不添加仅叙述代码行为的注释，注释只用于解释非显而易见的意图或约束

### Architecture Patterns

- **渠道自注册（Channel Self-Registration）**：各渠道（WhatsApp、Telegram、Slack、Discord、Gmail）在 `src/channels/` 下实现 `Channel` 接口，通过 `src/channels/registry.ts` 在启动时自动注册
- **消息队列（GroupQueue）**：每个群组有独立队列，保证同一群组的消息串行处理，不同群组并发执行（最多 `MAX_CONCURRENT_CONTAINERS` 个容器）
- **进程隔离**：每个群组的 agent 以独立 Node.js 子进程运行，通过 `NANOCLAW_GROUP_DIR`、`NANOCLAW_IPC_DIR` 等环境变量访问群组目录，不依赖容器运行时
- **IPC 通信**：容器通过 `data/ipc/{group}/` 目录下的文件系统 IPC 与宿主进程通信（`src/ipc.ts`）
- **状态持久化**：消息游标、会话 ID、群组注册信息等通过 SQLite 持久化（`src/db.ts`）
- **任务调度**：`src/task-scheduler.ts` 每分钟轮询待执行任务，支持 cron/interval/once，锚定任务计划时间防止漂移
- **触发词过滤**：非主群组需要 `@{ASSISTANT_NAME}` 触发词才会激活 agent；主群组（`isMain: true`）无需触发词，拥有更高权限
- **发件人白名单**：通过 `~/.config/nanoclaw/sender-allowlist.json` 控制哪些发件人可触发 agent（存储在容器外，防篡改）

### Testing Strategy

- 使用 Vitest 进行单元测试
- 测试文件与源文件同目录（`*.test.ts`）
- 运行：`npm test`（单次）或 `npm run test:watch`（监听模式）
- 覆盖率：`@vitest/coverage-v8`

### Git Workflow

- 主分支：`main`
- Husky git hooks 在提交前自动执行检查
- 提交前建议运行 `npm run typecheck` 和 `npm run format:check`

## Domain Context

- **群组（Group）**：对应一个消息平台的聊天/群（用 JID 标识），每个群有独立的 `groups/{folder}/` 目录，包含 `CLAUDE.md`（持久记忆）和 `logs/` 目录
- **主群组（Main Group）**：`isMain: true` 的特殊群组，agent 始终响应，无需触发词，具有注册新群组、管理任务等控制权限
- **会话（Session）**：每个群组的 agent 容器会话 ID，用于 Claude Agent SDK 的多轮对话记忆
- **技能（Skills）**：`.claude/skills/` 下的可插拔功能模块（如添加 WhatsApp、Telegram、语音转写等），通过脚本应用到项目
- **JID**：消息平台的聊天标识符（WhatsApp 使用 XMPP JID 格式，其他渠道有各自约定）

## Important Constraints

- **secrets 不写入环境变量**：API keys 等 secrets 只在 `process-runner.ts` 中读取并通过 stdin 注入子进程，不作为环境变量暴露
- **Node.js >= 20**：项目要求 Node.js 20 或以上
- **ESM 导入路径**：所有内部 import 必须使用 `.js` 扩展名

## External Dependencies

- **Claude API / Claude Agent SDK**：AI 推理后端，运行在容器内的 agent-runner 中
- **SQLite**（better-sqlite3）：本地数据库，存储所有状态数据，文件位于 `data/` 目录
- **消息平台 SDK**（按已安装技能不同）：
  - WhatsApp：Baileys（或类似库）
  - Telegram：Telegraf / Grammy
  - Slack：Slack Bolt SDK（Socket Mode）
  - Discord：Discord.js
  - Gmail：Google API Client（OAuth2）
- **macOS launchd / Linux systemd**：后台服务管理
