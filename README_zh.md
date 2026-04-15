<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  NanoClaw —— 面向个人的 Claude 助手骨架。当前默认运行时是宿主机上的 tmux 会话，而不是容器；代码库保持小巧、可理解、可定制。
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="README.md">English</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="34.9k tokens, 17% of context window" valign="middle"></a>
</p>
> 当前实现说明：NanoClaw 现在默认使用 `tmux` 在宿主机上运行任务，不再把 Docker、Apple Container 或 micro-VM 描述为当前默认路径。运行时兼容性和安全边界请参见 [docs/RUNTIME_COMPATIBILITY.md](docs/RUNTIME_COMPATIBILITY.md) 与 [docs/SECURITY.md](docs/SECURITY.md)。

## 我为什么创建这个项目

[OpenClaw](https://github.com/openclaw/openclaw) 是一个令人印象深刻的项目，但我无法安心使用一个我不了解却能访问我个人隐私的软件。OpenClaw 有近 50 万行代码、53 个配置文件和 70+ 个依赖项。其安全性是应用级别的（通过白名单、配对码实现），而非操作系统级别的隔离。所有东西都在一个共享内存的 Node 进程中运行。

NanoClaw 用一个您能快速理解的代码库提供同类核心能力。当前代码通过 tmux 会话在宿主机上执行任务，并通过显式挂载、凭据代理、发送者白名单和较窄的管理入口来控制风险。未来如果重新引入容器或 micro-VM，会走单独的运行时适配层，而不是继续让文档与实现漂移。

## 快速开始

```bash
git clone https://github.com/qwibitai/nanoclaw.git
cd nanoclaw
claude
```

然后运行 `/setup`。Claude Code 会处理依赖安装、身份验证、tmux 运行时检查和服务配置。

> **注意：** 以 `/` 开头的命令（如 `/setup`、`/add-whatsapp`）是 [Claude Code 技能](https://code.claude.com/docs/en/skills)。请在 `claude` CLI 提示符中输入，而非在普通终端中。

## 设计哲学

**小巧易懂：** 单一进程，少量源文件。无微服务、无消息队列、无复杂抽象层。让 Claude Code 引导您轻松上手。

**先说真话，再谈安全：** 当前默认运行时是宿主机上的 tmux 会话。安全边界来自显式挂载、只读项目根目录、每群组独立会话、发送者白名单、凭据代理以及受限的 host-exec 路径。这比共享内存里的单进程代理更安全，但它不是容器隔离。

**为单一用户打造:** 这不是一个框架，是一个完全符合您个人需求的、可工作的软件。您可以 Fork 本项目，然后让 Claude Code 根据您的精确需求进行修改和适配。

**定制即代码修改:** 没有繁杂的配置文件。想要不同的行为？直接修改代码。代码库足够小，这样做是安全的。

**AI 原生:** 无安装向导（由 Claude Code 指导安装）。无需监控仪表盘，直接询问 Claude 即可了解系统状况。无调试工具（描述问题，Claude 会修复它）。

**技能（Skills）优于功能（Features）:** 贡献者不应该向代码库添加新功能（例如支持 Telegram）。相反，他们应该贡献像 `/add-telegram` 这样的 [Claude Code 技能](https://code.claude.com/docs/en/skills)，这些技能可以改造您的 fork。最终，您得到的是只做您需要事情的整洁代码。

**运行时适配层，而不是运行时漂移：** 现在已经抽出了运行时适配层，后续如果重新引入 Docker、Apple Container 或 micro-VM，可以在清晰边界后面演进，而不是继续让文档和实现不一致。

## 核心仓库当前提供什么

- **核心内置 Telegram 渠道代码** - 其他渠道应通过 skill 或下游 fork 添加。
- **每个群组独立上下文** - 各自的 `CLAUDE.md`、文件、会话和挂载。
- **主频道管理能力** - 群组注册、跨群组任务可见性、管理控制。
- **计划任务与 Agency HQ 调度** - 包括并行槽位、恢复逻辑和工作树。
- **会话命令** - `/compact` 与 `/clear` 已在核心中实现。
- **健康检查** - 进程提供 `GET /skills` 与 `GET /health`。

## 实验性或按安装决定的能力

- 其他渠道与集成
- Agent Teams / Swarms
- Remote control
- 容器或 micro-VM 运行时

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

## 系统要求

- macOS 或 Linux，并安装 `tmux`
- Node.js 20+
- [Claude Code](https://claude.ai/download)
- Windows 仅建议通过 WSL 试验性使用

## 运维检查

```bash
npm run smoke:runtime
npm run smoke:health
```

## 贡献

**不要添加功能，而是添加技能。**

如果您想添加渠道、集成或工作流，优先考虑提交 skill，而不是继续扩张核心仓库。

然后用户在自己的 fork 上运行 `/add-telegram`，就能得到只做他们需要事情的整洁代码，而不是一个试图支持所有用例的臃肿系统。

### RFS (技能征集)

我们希望看到的技能：

**通信渠道**

- `/add-signal` - 添加 Signal 作为渠道

更多细节请参见：

- [docs/PROJECT_STATUS.md](docs/PROJECT_STATUS.md)
- [docs/RUNTIME_COMPATIBILITY.md](docs/RUNTIME_COMPATIBILITY.md)
- [docs/SECURITY.md](docs/SECURITY.md)
- [docs/SETUP_RECOVERY.md](docs/SETUP_RECOVERY.md)

## FAQ

**为什么不是容器默认运行？**

因为当前代码实际运行的是 tmux 宿主机会话。现在仓库已经先把事实说清楚，再为未来的隔离运行时保留干净接口。

**这个项目安全吗？**

比“所有东西都在一个共享进程里”的系统更安全，但默认也不是容器隔离。请先阅读 [docs/SECURITY.md](docs/SECURITY.md) 再决定给予哪些宿主机访问权限。

**我可以在 Linux 上运行吗？**

可以。Linux 是当前 tmux 运行时的主要目标平台。

**我可以在 Windows 上运行吗？**

目前只建议通过 WSL 试验性使用，原生 Windows 还不在支持范围内。

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

如果遇到问题，安装过程中 Claude 会尝试动态修复。如果问题仍然存在，运行 `claude`，然后运行 `/debug`。如果 Claude 发现一个可能影响其他用户的问题，请开一个 PR 来修改 setup SKILL.md。

**什么样的代码更改会被接受？**

安全修复、bug 修复、部署与运维强化、正确性改进，以及减少复杂度的重构。

大多数新能力仍应通过 skill 提供。

## 社区

有任何疑问或建议？欢迎[加入 Discord 社区](https://discord.gg/VDdww8qS42)与我们交流。

## 更新日志

破坏性变更和迁移说明请见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

MIT
