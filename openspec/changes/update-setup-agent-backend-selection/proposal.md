# Change: Update Setup Skill — Agent Backend Selection

## Why

NanoClaw 现已支持两种 agent 后端（`AGENT_BACKEND=claude | cursor`），但 `.claude/skills/setup/SKILL.md` 的 Step 3 仍仅引导用户做 Claude 认证，完全没有提及 Cursor 选项。首次安装的用户无从得知可以选择 Cursor，也不知道如何配置。

## What Changes

- 在 `SKILL.md` Step 2（Check Environment）之后、Step 3（Claude Authentication）之前**插入一个新步骤**：
  > **Step 3 — Agent Backend Selection**
  >
  > `AskUserQuestion`：选择 agent 后端
  > - **Claude**（默认）：使用 Claude Agent SDK，需要 `ANTHROPIC_API_KEY` 或 claude CLI 登录
  > - **Cursor**：使用 Cursor CLI headless 模式，需要已安装并登录 Cursor，且 `agent` CLI 可用
  >
  > 根据选择：
  > - 选 **Claude** → 继续现有的 Claude Authentication 步骤（无变化）
  > - 选 **Cursor** → 引导 Cursor 配置：
  >   1. 检查 `agent` CLI 是否可用（`which agent`）；若缺失，`AskUserQuestion` 确认后运行 `curl https://cursor.com/install -fsS | bash` 自动安装，安装完成后再次验证 `which agent`
  >   2. 检查登录状态（`agent --version`）；若未登录，提示用户在另一个终端运行 `agent login`
  >   3. 在 `.env` 中写入 `AGENT_BACKEND=cursor`
  >   4. 如果 `.env` 已存在 `ANTHROPIC_API_KEY`，告知用户 Cursor 模式不需要它，但保留不删除
  >   5. 跳过后续的 Claude Authentication 步骤（Step 4 → Step 3 offset）

- 将原 Step 3（Claude Authentication）重命名为 **Step 4**，步骤编号整体向后移一位
- 更新 Troubleshooting 区块，新增：
  > **Wrong agent backend:** Check `AGENT_BACKEND` in `.env`. Valid values: `claude` (default) or `cursor`. Restart service after changing.

## Scope

仅修改 `.claude/skills/setup/SKILL.md`（纯文档/指令变更，无 TypeScript 代码改动）。

## Impact

- Affected files:
  - `.claude/skills/setup/SKILL.md` — 主要目标，插入 Backend Selection 步骤，重新编号，更新 Troubleshooting
- No runtime code changes required（`AGENT_BACKEND` 已由 `src/config.ts` 支持，cursor-runner 已实现）
