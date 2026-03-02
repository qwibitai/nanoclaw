<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  NanoClaw —— 您的专属 Claude 助手，在容器中安全运行。它轻巧易懂，并能根据您的个人需求灵活定制。
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="README.md">English</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="34.9k tokens, 17% of context window" valign="middle"></a>
</p>

**新功能：** 首个支持 [Agent Swarms（智能体集群）](https://code.claude.com/docs/en/agent-teams) 的 AI 助手。可轻松组建智能体团队，在您的聊天中高效协作。

## 我为什么创建这个项目

[OpenClaw](https://github.com/openclaw/openclaw) 是一个令人印象深刻的项目，愿景宏大。但我无法安心使用一个我不了解却能访问我个人隐私的软件。OpenClaw 有 52+ 个模块、8 个配置管理文件、45+ 个依赖项，以及为 15 个渠道提供商设计的抽象层。其安全性是应用级别的（通过白名单、配对码实现），而非操作系统级别的隔离。所有东西都在一个共享内存的 Node 进程中运行。

NanoClaw 用一个您能在 8 分钟内理解的代码库，为您提供了同样的核心功能。只有一个进程，少数几个文件。智能体（Agent）运行在具有文件系统隔离的真实 Linux 容器中，而不是依赖于权限检查。

## 快速开始

```bash
git clone https://github.com/qwibitai/nanoclaw.git
cd nanoclaw
claude
```

然后运行 `/setup`。Claude Code 会处理一切：依赖安装、身份验证、容器设置、服务配置。

## 设计哲学

**小巧易懂：** 单一进程，少量源文件。无微服务、无消息队列、无复杂抽象层。让 Claude Code 引导您轻松上手。

**通过隔离保障安全:** 智能体运行在 Linux 容器（在 macOS 上是 Apple Container，或 Docker）中。它们只能看到被明确挂载的内容。即便通过 Bash 访问也十分安全，因为所有命令都在容器内执行，不会直接操作您的宿主机。

**为单一用户打造:** 这不是一个框架，是一个完全符合我个人需求的、可工作的软件。您可以 Fork 本项目，然后让 Claude Code 根据您的精确需求进行修改和适配。

**定制即代码修改:** 没有繁杂的配置文件。想要不同的行为？直接修改代码。代码库足够小，这样做是安全的。

**AI 原生:** 无安装向导(由 Claude Code 指导安装)。无需监控仪表盘，直接询问 Claude 即可了解系统状况。无调试工具(描述问题，Claude 会修复它)。

**技能（Skills）优于功能（Features）:** 贡献者不应该向代码库添加新功能（例如支持 Telegram）。相反，他们应该贡献像 `/add-telegram` 这样的 [Claude Code 技能](https://code.claude.com/docs/en/skills)，这些技能可以改造您的 fork。最终，您得到的是只做您需要事情的整洁代码。

**最好的工具套件，最好的模型:** 本项目运行在 Claude Agent SDK 之上，这意味着您直接运行的就是 Claude Code。工具套件至关重要。一个低效的工具套件会让再聪明的模型也显得迟钝，而一个优秀的套件则能赋予它们超凡的能力。Claude Code (在我看来) 是市面上最好的工具套件。

## 功能支持

- **WhatsApp 输入/输出** - 通过手机给 Claude 发消息
- **隔离的群组上下文** - 每个群组都拥有独立的 `CLAUDE.md` 记忆和隔离的文件系统。它们在各自的容器沙箱中运行，且仅挂载所需的文件系统。
- **主频道** - 您的私有频道（self-chat），用于管理控制；其他所有群组都完全隔离
- **计划任务** - 运行 Claude 的周期性作业，并可以给您回发消息
- **网络访问** - 搜索和抓取网页内容
- **容器隔离** - 智能体在 Apple Container (macOS) 或 Docker (macOS/Linux) 的沙箱中运行
- **智能体集群（Agent Swarms）** - 启动多个专业智能体团队，协作完成复杂任务（首个支持此功能的个人 AI 助手）
- **可选集成** - 通过技能添加 Gmail (`/add-gmail`) 等更多功能

## 使用方法

使用触发词（默认为 `@Andy`）与您的助手对话：

```
@Andy 每周一到周五早上9点，给我发一份销售渠道的概览（需要访问我的 Obsidian vault 文件夹）
@Andy 每周五回顾过去一周的 git 历史，如果与 README 有出入，就更新它
@Andy 每周一早上8点，从 Hacker News 和 TechCrunch 收集关于 AI 发展的资讯，然后发给我一份简报
```

在主频道（您的self-chat）中，可以管理群组和任务：
```
@Andy 列出所有群组的计划任务
@Andy 暂停周一简报任务
@Andy 加入"家庭聊天"群组
```

## 定制

没有需要学习的配置文件。直接告诉 Claude Code 您想要什么：

- "把触发词改成 @Bob"
- "记住以后回答要更简短直接"
- "当我说早上好的时候，加一个自定义的问候"
- "每周存储一次对话摘要"

或者运行 `/customize` 进行引导式修改。

代码库足够小，Claude 可以安全地修改它。

## 贡献

**不要添加功能，而是添加技能。**

如果您想添加 Telegram 支持，不要创建一个 PR 同时添加 Telegram 和 WhatsApp。而是贡献一个技能文件 (`.claude/skills/add-telegram/SKILL.md`)，教 Claude Code 如何改造一个 NanoClaw 安装以使用 Telegram。

然后用户在自己的 fork 上运行 `/add-telegram`，就能得到只做他们需要事情的整洁代码，而不是一个试图支持所有用例的臃肿系统。

### RFS (技能征集)

我们希望看到的技能：

**通信渠道**
- `/add-telegram` - 添加 Telegram 作为渠道。应提供选项让用户选择替换 WhatsApp 或作为额外渠道添加。也应能将其添加为控制渠道（可以触发动作）或仅作为被其他地方触发的动作所使用的渠道。
- `/add-slack` - 添加 Slack
- `/add-discord` - 添加 Discord

**平台支持**
- `/setup-windows` - 通过 WSL2 + Docker 支持 Windows

**会话管理**
- `/add-clear` - 添加一个 `/clear` 命令，用于压缩会话（在同一会话中总结上下文，同时保留关键信息）。这需要研究如何通过 Claude Agent SDK 以编程方式触发压缩。

## 系统要求

- macOS 或 Linux
- Node.js 20+
- [Claude Code](https://claude.ai/download)
- [Apple Container](https://github.com/apple/container) (macOS) 或 [Docker](https://docker.com/products/docker-desktop) (macOS/Linux)

## 架构

```
WhatsApp (baileys) --> SQLite --> 轮询循环 --> 容器 (Claude Agent SDK) --> 响应
```

单一 Node.js 进程。智能体在具有挂载目录的隔离 Linux 容器中执行。每个群组的消息队列都带有全局并发控制。通过文件系统进行进程间通信（IPC）。

关键文件：
- `src/index.ts` - 编排器：状态管理、消息循环、智能体调用
- `src/channels/whatsapp.ts` - WhatsApp 连接、认证、收发消息
- `src/ipc.ts` - IPC 监听与任务处理
- `src/router.ts` - 消息格式化与出站路由
- `src/group-queue.ts` - 各带全局并发限制的群组队列
- `src/container-runner.ts` - 生成流式智能体容器
- `src/task-scheduler.ts` - 运行计划任务
- `src/db.ts` - SQLite 操作（消息、群组、会话、状态）
- `groups/*/CLAUDE.md` - 各群组的记忆

## FAQ

**为什么是 WhatsApp 而不是 Telegram/Signal 等？**

因为我用 WhatsApp。Fork 这个项目然后运行一个技能来改变它。正是这个项目的核心理念。

**为什么是 Docker？**

Docker 提供跨平台支持（macOS 和 Linux）和成熟的生态系统。在 macOS 上，您可以选择通过运行 `/convert-to-apple-container` 切换到 Apple Container，以获得更轻量级的原生运行时体验。

**我可以在 Linux 上运行吗？**

可以。Docker 是默认的容器运行时，在 macOS 和 Linux 上都可以使用。只需运行 `/setup`。

**这个项目安全吗？**

智能体在容器中运行，而不是在应用级别的权限检查之后。它们只能访问被明确挂载的目录。您仍然应该审查您运行的代码，但这个代码库小到您真的可以做到。完整的安全模型请见 [docs/SECURITY.md](docs/SECURITY.md)。

**为什么没有配置文件？**

我们不希望配置泛滥。每个用户都应该定制它，让代码完全符合他们的需求，而不是去配置一个通用的系统。如果您喜欢用配置文件，告诉 Claude 让它加上。

**我可以使用第三方或开源模型吗？**

可以。NanoClaw 支持任何 API 兼容的模型端点。在 `.env` 文件中设置以下环境变量：

```bash
ANTHROPIC_BASE_URL=https://your-api-endpoint.com
ANTHROPIC_AUTH_TOKEN=your-token-here
```

这使您能够使用：
- 通过 [Ollama](https://ollama.ai) 配合 API 代理运行的本地模型
- 托管在 [Together AI](https://together.ai)、[Fireworks](https://fireworks.ai) 等平台上的开源模型
- 兼容 Anthropic API 格式的自定义模型部署

注意：为获得最佳兼容性，模型需支持 Anthropic API 格式。

**我该如何调试问题？**

问 Claude Code。"为什么计划任务没有运行？" "最近的日志里有什么？" "为什么这条消息没有得到回应？" 这就是 AI 原生的方法。

**为什么我的安装不成功？**

我不知道。运行 `claude`，然后运行 `/debug`。如果 Claude 发现一个可能影响其他用户的问题，请开一个 PR 来修改 `SKILL.md` 安装文件。

**什么样的代码更改会被接受？**

安全修复、bug 修复，以及对基础配置的明确改进。仅此而已。

其他一切（新功能、操作系统兼容性、硬件支持、增强功能）都应该作为技能来贡献。

这使得基础系统保持最小化，并让每个用户可以定制他们的安装，而无需继承他们不想要的功能。

## 社区

有任何疑问或建议？欢迎[加入 Discord 社区](https://discord.gg/VDdww8qS42)与我们交流。

## 许可证

MIT
