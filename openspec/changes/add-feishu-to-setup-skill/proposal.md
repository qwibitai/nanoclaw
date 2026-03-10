# Change: Add Feishu to Setup Skill Channel Selection

## Why

`.claude/skills/setup/SKILL.md` 的 Step 5（Set Up Channels）列出了 WhatsApp、Telegram、Slack、Discord 四个渠道，但遗漏了 Feishu（飞书）。`/add-feishu` skill 已存在且完整，setup 流程只需把它纳入选项并委托调用。

## What Changes

仅修改 `.claude/skills/setup/SKILL.md`：

1. 在 Step 5 的 `AskUserQuestion (multiSelect)` 选项中追加：
   > - Feishu (authenticates via self-built app with App ID and App Secret)

2. 在委托调用列表中追加：
   > - **Feishu:** Invoke `/add-feishu`

## Scope

纯文档/指令变更，无 TypeScript 代码改动。`/add-feishu` skill 本身已包含完整的安装、认证、注册、验证逻辑。

## Impact

- Affected files:
  - `.claude/skills/setup/SKILL.md` — 唯一改动目标
