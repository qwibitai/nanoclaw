# Tasks: Add Feishu to Setup Skill Channel Selection

## 1. Update Channel List

- [x] 1.1 在 Step 5 的 `AskUserQuestion (multiSelect)` 选项末尾追加 `- Feishu (authenticates via self-built app with App ID and App Secret)`
- [x] 1.2 在委托调用列表末尾追加 `- **Feishu:** Invoke /add-feishu`

## 2. Validate

- [x] 2.1 人工确认两处新增内容与其他渠道条目格式一致
- [x] 2.2 运行 `openspec validate add-feishu-to-setup-skill --strict`，无错误
