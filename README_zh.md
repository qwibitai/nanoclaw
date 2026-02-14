<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  我的个人 Claude 助手，安全地运行在容器中。它轻巧、易于理解，并可根据你自己的需求进行定制。
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="https://discord.gg/VGWXrf8x"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord"></a>
</p>

**新功能:** 首个支持 [Agent Swarms（智能体集群）](https://code.claude.com/docs/en/agent-teams) 的 AI 助手。在你的聊天中启动多个协作智能体团队。

## 我为什么创建这个项目

[OpenClaw](https://github.com/openclaw/openclaw) 是一个令人印象深刻的项目，愿景宏大。但我无法安心地运行一个我不了解、却能接触我个人生活的软件。OpenClaw 有 52 多个模块、8 个配置管理文件、45 多个依赖项，以及为 15 个渠道提供商设计的抽象层。其安全性是应用级别的（通过白名单、配对码），而非操作系统级别的隔离。所有东西都在一个共享内存的 Node 进程中运行。

NanoClaw 用一个你能在 8 分钟内理解的代码库，为你提供了同样的核心功能。只有一个进程，寥寥数个文件。智能体（Agent）运行在具有文件系统隔离的真实 Linux 容器中，而不是依赖于权限检查。

## 快速上手

```bash
git clone https://github.com/gavrielc/nanoclaw.git
cd nanoclaw
claude
```

然后运行 `/setup`。Claude Code 会处理一切：依赖安装、身份验证、容器设置、服务配置。

## 设计哲学

**小到可以理解:** 一个进程，几个源文件。没有微服务，没有消息队列，没有抽象层。让 Claude Code 带你过一遍代码。

**通过隔离保障安全:** 智能体运行在 Linux 容器（在 macOS 上是 Apple Container，或 Docker）中。它们只能看到被明确挂载的内容。即使是 Bash 访问也是安全的，因为命令是在容器内部执行，而不是在你的主机上。

**为单一用户打造:** 这不是一个框架。这是一个完全符合我个人需求的、可工作的软件。你应该 fork 它，然后让 Claude Code 修改它以完全匹配你的需求。

**定制即代码修改:** 没有繁杂的配置文件。想要不同的行为？直接修改代码。代码库足够小，这样做是安全的。

**AI 原生:** 无安装向导(由 Claude Code 指导安装)。无监控仪表盘(直接问 Claude 发生了什么)。无调试工具(描述问题，Claude 会修复它)。

**技能（Skills）优于功能（Features）:** 贡献者不应该向代码库添加新功能（例如支持 Telegram）。相反，他们应该贡献像 `/add-telegram` 这样的 [Claude Code 技能](https://code.claude.com/docs/en/skills)，这些技能可以改造你的 fork。最终，你得到的是只做你需要事情的整洁代码。

**最好的工具套件，最好的模型:** 本项目运行在 Claude Agent SDK 之上，这意味着你直接运行的就是 Claude Code。工具套件至关重要。一个糟糕的套件即使是聪明的模型也会显得愚笨，而一个好的套件则能赋予它们超能力。Claude Code (在我看来) 是市面上最好的工具套件。

## 功能支持

- **WhatsApp 输入/输出** - 通过手机给 Claude 发消息
- **隔离的群组上下文** - 每个群组都有其独立的 `CLAUDE.md` 记忆、隔离的文件系统，并在其自己的容器沙箱中运行，只挂载该文件系统
- **主频道** - 你的私有频道（self-chat），用于管理控制；其他所有群组都完全隔离
- **计划任务** - 运行 Claude 的周期性作业，并可以给你回发消息
- **网络访问** - 搜索和抓取网页内容
- **容器隔离** - 智能体在 Apple Container (macOS) 或 Docker (macOS/Linux) 的沙箱中运行
- **智能体集群（Agent Swarms）** - 启动多个专业智能体团队，协作完成复杂任务（首个支持此功能的个人 AI 助手）
- **可选集成** - 通过技能添加 Gmail (`/add-gmail`) 等更多功能

## 使用方法

使用触发词（默认为 `@Andy`）与你的助手对话：

```
@Andy 每周一到周五早上9点，给我发一份销售渠道的概览（需要访问我的 Obsidian vault 文件夹）
@Andy 每周五回顾过去一周的 git 历史，如果与 README 有出入，就更新它
@Andy 每周一早上8点，从 Hacker News 和 TechCrunch 收集关于 AI 发展的资讯，然后发给我一份简报
```

在主频道（你的self-chat）中，可以管理群组和任务：
```
@Andy 列出所有群组的计划任务
@Andy 暂停周一简报任务
@Andy 加入"家庭聊天"群组
```

## 定制

没有需要学习的配置文件。直接告诉 Claude Code 你想要什么：

- "把触发词改成 @Bob"
- "记住以后回答要更简短直接"
- "当我说早上好的时候，加一个自定义的问候"
- "每周存储一次对话摘要"

或者运行 `/customize` 进行引导式修改。

代码库足够小，Claude 可以安全地修改它。

## 贡献

**不要添加功能，而是添加技能。**

如果你想添加 Telegram 支持，不要创建一个 PR 同时添加 Telegram 和 WhatsApp。而是贡献一个技能文件 (`.claude/skills/add-telegram/SKILL.md`)，教 Claude Code 如何改造一个 NanoClaw 安装以使用 Telegram。

然后用户在自己的 fork 上运行 `/add-telegram`，就能得到只做他们需要的事情的整洁代码，而不是一个试图支持所有用例的臃肿系统。

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

单一 Node.js 进程。智能体在具有挂载目录的隔离 Linux 容器中执行。每个群组独立的消息队列，带全局并发控制。通过文件系统进行进程间通信（IPC）。

关键文件：
- `src/index.ts` - 编排器：状态管理、消息循环、智能体调用
- `src/channels/whatsapp.ts` - WhatsApp 连接、认证、收发消息
- `src/ipc.ts` - IPC 监听与任务处理
- `src/router.ts` - 消息格式化与出站路由
- `src/group-queue.ts` - 每群组队列，带全局并发限制
- `src/container-runner.ts` - 生成流式智能体容器
- `src/task-scheduler.ts` - 运行计划任务
- `src/db.ts` - SQLite 操作（消息、群组、会话、状态）
- `groups/*/CLAUDE.md` - 各群组的记忆

## FAQ

**为什么是 WhatsApp 而不是 Telegram/Signal 等？**

因为我用 WhatsApp。fork 这个项目然后运行一个技能来改变它。正是这个项目的核心理念。

**为什么是 Apple Container 而不是 Docker？**

在 macOS 上，Apple Container 轻巧、快速，并为 Apple 芯片优化。但 Docker 也完全支持——在 `/setup` 期间，你可以选择使用哪个运行时。在 Linux 上，会自动使用 Docker。

**我可以在 Linux 上运行吗？**

可以。运行 `/setup`，它会自动配置 Docker 作为容器运行时。感谢 [@dotsetgreg](https://github.com/dotsetgreg) 贡献了 `/convert-to-docker` 技能。

**这个安全吗？**

智能体在容器中运行，而不是在应用级别的权限检查之后。它们只能访问被明确挂载的目录。你仍然应该审查你运行的代码，但这个代码库小到你真的可以做到。完整的安全模型请见 [docs/SECURITY.md](docs/SECURITY.md)。

**为什么没有配置文件？**

我们不希望配置泛滥。每个用户都应该定制它，让代码完全符合他们的需求，而不是去配置一个通用的系统。如果你喜欢用配置文件，告诉 Claude 让它加上。

**我该如何调试问题？**

问 Claude Code。"为什么计划任务没有运行？" "最近的日志里有什么？" "为什么这条消息没有得到回应？" 这就是 AI 原生的方法。

**为什么我的安装不成功？**

我不知道。运行 `claude`，然后运行 `/debug`。如果 Claude 发现一个可能影响其他用户的问题，请开一个 PR 来修改 `SKILL.md` 安装文件。

**什么样的代码更改会被接受？**

安全修复、bug 修复，以及对基础配置的明确改进。仅此而已。

其他一切（新功能、操作系统兼容性、硬件支持、增强功能）都应该作为技能来贡献。

这使得基础系统保持最小化，并让每个用户可以定制他们的安装，而无需继承他们不想要的功能。

## 社区

有问题？有想法？[加入 Discord](https://discord.gg/VGWXrf8x)。

## 许可证

MIT
