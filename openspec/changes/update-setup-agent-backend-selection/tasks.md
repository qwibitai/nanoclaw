# Tasks: Update Setup Skill — Agent Backend Selection

## 1. Insert Backend Selection Step

- [x] 1.1 在 SKILL.md Step 2 之后插入新的 **Step 3 — Agent Backend**：
  - `AskUserQuestion`（singleSelect）：选择 Claude 或 Cursor
  - Claude 分支：直接跳到（新编号的）Step 4
  - Cursor 分支：
    - 检查 `agent` CLI 是否存在（`which agent`）；若缺失，`AskUserQuestion` 确认后运行 `curl https://cursor.com/install -fsS | bash`，再验证
    - 检查登录状态（`agent --version`）；若未登录，提示用户运行 `agent login`
    - 写入 `AGENT_BACKEND=cursor` 到 `.env`
    - 跳过 Step 4（Claude Authentication）

## 2. Renumber Steps

- [x] 2.1 将原 Step 3（Claude Authentication）重命名为 Step 4，依次将 Step 4→5、5→6、6→7、7→8、8→9；更新所有步骤内的交叉引用

## 3. Update Troubleshooting

- [x] 3.1 在 Troubleshooting 区块新增 **Wrong agent backend** 条目，说明如何通过 `.env` 中的 `AGENT_BACKEND` 切换

## 4. Validate

- [x] 4.1 人工通读 SKILL.md，确认步骤编号连续、分支逻辑清晰、无遗漏交叉引用
- [x] 4.2 运行 `openspec validate update-setup-agent-backend-selection --strict`，无错误
