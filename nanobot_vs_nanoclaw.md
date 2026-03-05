# nanobot vs nanoclaw: 核心架构对比分析

本文对比分析 **nanobot**（本项目）与 **[nanoclaw](https://github.com/mrzeichi/nanoclaw)** 两个轻量级个人 AI 助手框架的核心功能架构与实现，列出最大的差异与相似之处。

---

## 主要差异（Top 5）

### 1. 技术栈与语言

| | nanobot | nanoclaw |
|---|---|---|
| **语言** | Python 3.11+ | TypeScript / Node.js 20+ |
| **核心依赖** | litellm、pydantic、loguru | Claude Agent SDK（Claude Code CLI） |
| **分发方式** | PyPI 包（`pip install nanobot-ai`）| Git 克隆后由 Claude Code 向导安装 |

nanobot 是一个标准 Python 包，可通过 pip 安装并通过 YAML 配置驱动；nanoclaw 本质上是一个"活代码库"，通过 Claude Code 的 skill 机制完成初始化和扩展。

---

### 2. Agent 执行模型：同进程 vs 容器隔离

**nanobot** 的 Agent 在同一 Python 进程内运行（`nanobot/agent/loop.py`）：

```
InboundMessage → MessageBus → AgentLoop → LLMProvider → Tool执行 → OutboundMessage
```

- Agent loop 直接管理会话历史、工具调用和上下文
- 工具（文件、Shell、Web、MCP）在同一进程中执行
- 安全边界依赖应用层（工作空间限制、allowlist）

**nanoclaw** 的每次 Agent 会话都运行在独立的 Linux **容器**（Apple Container 或 Docker）内：

```
Messages(SQLite) → Polling loop → runContainerAgent() → Container(Claude Code) → IPC响应
```

- 容器仅挂载对应 group 的目录，实现 OS 级文件系统隔离
- Agent 通过 IPC（文件系统）与主进程通信
- Shell 命令在容器内执行，不影响宿主机

这是两者**最核心**的架构差异：nanobot 追求极简直接，nanoclaw 追求安全隔离。

---

### 3. LLM 提供商支持范围

**nanobot** 通过 litellm 支持 **15+ 个 LLM 提供商**：

- Anthropic、OpenAI、OpenRouter、DeepSeek、Groq
- ZhipuAI、DashScope（阿里云通义千问）、Gemini
- Moonshot（Kimi）、MiniMax、AiHubMix、SiliconFlow（硅基流动）、VolcEngine（火山引擎）
- vLLM（本地部署）、OpenAI Codex（OAuth）、GitHub Copilot

**nanoclaw** **目前仅支持 Claude**（通过 Claude Agent SDK），对其他模型提供商的支持有限（官方仅提供可替换 base URL 的有限扩展）。

nanobot 在多模型支持上远胜 nanoclaw，尤其适合中国用户使用国产大模型。

---

### 4. 配置方式：配置文件 vs 代码即配置

**nanobot** 使用完整的 YAML/环境变量配置体系（Pydantic schema 验证，`nanobot/config/schema.py`）：

- 每个 channel 有独立的配置项（enable、token、allow_from、proxy 等）
- 支持 50+ 配置选项，通过 `~/.nanobot/config.yml` 集中管理
- 修改行为无需改动代码

**nanoclaw** 完全**没有配置文件**：

- 功能定制 = 直接修改源代码（或告诉 Claude Code 帮你改）
- 触发词、渠道凭证等均写死或通过 `.env` 环境变量读取
- 哲学是"bespoke code"而非"generic configuration"

---

### 5. 技能/扩展架构：运行时插件 vs 安装时代码变换

**nanobot** 的 skills（技能）是**运行时插件**：

- `nanobot/skills/` 目录包含可动态加载的技能模块
- 同时支持 **MCP（Model Context Protocol）** 服务器接入，可外接任意 MCP 工具
- Agent 运行时动态调用

**nanoclaw** 的 skills 是**安装时代码变换**（Claude Code skills）：

- `.claude/skills/add-telegram/SKILL.md` 等文件是 Claude Code 的操作指南
- 用户运行 `/add-telegram` 时，Claude Code 读取指南并**修改源代码**以添加该渠道
- 安装后的代码库中只包含用户实际需要的功能，不存在运行时插件机制
- 本质上是"教会 AI 工程师如何改造代码库"

---

## 相似之处（Top 5）

### 1. 同样轻量，同为 OpenClaw 的精简替代品

两者都明确对标 OpenClaw（半百万行代码），以极简为核心设计原则：

- **nanobot**：核心约 4,000 行 Python 代码，标语"99% smaller than Clawdbot"
- **nanoclaw**：强调"one process, a handful of files"，"small enough to understand"

两者都认为代码可读性和可审计性是安全性的基础。

---

### 2. 多渠道消息接入

两者都支持将同一 AI Agent 接入多个即时通讯平台：

| 平台 | nanobot | nanoclaw |
|---|---|---|
| WhatsApp | ✅ | ✅（via skill） |
| Telegram | ✅ | ✅（via skill） |
| Discord | ✅ | ✅（via skill） |
| Slack | ✅ | ✅（via skill） |
| Feishu/飞书 | ✅ | — |
| DingTalk/钉钉 | ✅ | — |
| Email | ✅ | ✅（via skill） |
| Matrix | ✅ | — |
| QQ | ✅ | — |

---

### 3. 定时任务（Cron）调度

两者都支持定时/周期性任务，让 Agent 在无人触发的情况下自动运行并推送消息：

- **nanobot**：`nanobot/cron/` 模块 + `CronTool`，Agent 可通过工具调用创建/管理定时任务
- **nanoclaw**：`src/task-scheduler.ts`，通过 `TaskScheduler` 管理 cron 任务，定时触发容器执行

---

### 4. 持久化会话与上下文记忆

两者都维护跨消息的会话状态，使 Agent 具备上下文连续性：

- **nanobot**：`nanobot/session/` 管理会话，`nanobot/agent/memory.py` 管理记忆窗口（最近 N 条消息 + 滚动压缩）
- **nanoclaw**：SQLite（`src/db.ts`）存储所有消息，每个 group 有独立的 `CLAUDE.md` 记忆文件，Claude Agent SDK 的 session ID 跨会话复用

---

### 5. 多 Agent 协作（Subagent / Swarm）

两者都支持多 Agent 并行或协作场景：

- **nanobot**：`SubagentManager` + `SpawnTool`，主 Agent 可动态 spawn 子 Agent 处理子任务，子 Agent 共享同一进程内的工具
- **nanoclaw**：支持 **Agent Swarms**（官方宣传为首个支持 Agent Swarm 的个人 AI 助手），多个 Agent 容器可并行运行，通过 `GroupQueue` 管理并发

---

## 总结

| 维度 | nanobot | nanoclaw |
|---|---|---|
| 语言 | Python | TypeScript |
| Agent 执行 | 同进程 | 容器隔离 |
| LLM 支持 | 15+ 提供商 | 仅 Claude |
| 配置方式 | YAML 配置文件 | 代码即配置 |
| 扩展机制 | 运行时插件 + MCP | 安装时代码变换（Claude Code skills） |
| 多渠道 | ✅（内置 10 种） | ✅（via skills） |
| 定时任务 | ✅ | ✅ |
| 持久记忆 | ✅ | ✅ |
| 多 Agent | ✅ | ✅ |
| 轻量哲学 | ✅ | ✅ |

两者都是 OpenClaw 的轻量化精神继承者，但走了不同的技术路线：nanobot 注重**多模型兼容性和可配置性**，nanoclaw 注重**安全隔离和 AI 原生的代码自定义**。
