---
name: skill-discovery
description: Create new skills when the user requests functionality that doesn't exist. Use when user asks for a capability not covered by existing skills. Automatically research, develop, and package new skills following Anthropic's skill structure.
---

# Skill Discovery & Generation

當使用者要求不存在的功能時，自動創建新的 skill。

## 核心理念

**"The context window is a public good."** - 只包含 Claude 不知道的資訊。

每個新 skill 都應該：
- **簡潔** - 只包含必要資訊
- **模組化** - 獨立且可重用
- **具體** - 明確指定使用時機

## 工作流程

### 1. 識別需求

使用者提出功能請求 → 分析他們想達成什麼。

### 2. 檢查現有 Skills

```bash
# 列出所有 skills
ls -d /workspace/project/.claude/skills/*/

# 搜尋描述
grep -r "description:" /workspace/project/.claude/skills/*/SKILL.md
```

如果找到相關 skill → 直接使用。

### 3. 研究方案

如果沒有現有 skill：

1. **WebSearch** 最佳實現方式
2. 查找相關函式庫和工具
3. 了解最佳實踐

### 4. 創建新 Skill

使用 init_skill.py 初始化：

```bash
python3 /workspace/project/.claude/skills/skill-discovery/scripts/init_skill.py \
  skill-name \
  --description "Create widgets from templates with validation"
```

這會創建：
```
.claude/skills/skill-name/
├── SKILL.md              # Skill 說明
├── README.md             # 開發文檔
├── skill_name.py         # 主腳本
├── scripts/              # 額外工具
├── references/           # 參考文件
└── assets/               # 模板和資源
```

### 5. 實現功能

#### 編輯 SKILL.md

frontmatter description **最關鍵** - 指定「何時使用」：

```yaml
---
name: uuid-generator
description: Generate UUID v4 identifiers when unique IDs are needed for resources, sessions, or transactions
---
```

**好的 description：**
- 說明使用時機
- 簡潔但具體
- 突出關鍵用途

**不好的 description：**
- 只說是什麼：「A UUID generator」
- 太模糊：「Generates IDs」
- 太冗長：解釋 UUID 的歷史

#### 實現腳本

遵循標準介面：

```python
def main(args):
    """主要函數"""
    try:
        # 實現邏輯
        return {
            "success": True,
            "result": "人類可讀結果",
            "data": {...}
        }
    except Exception as e:
        return {
            "success": False,
            "error": str(e)
        }
```

支援 `--json` 輸出：
```bash
python3 script.py --param value --json
```

#### 選擇適當的結構

根據複雜度：

- **簡單功能** → 只需 SKILL.md + 一個腳本
- **中等複雜** → 添加 references/ 文檔
- **複雜工作流** → 使用 scripts/ 和 assets/

### 6. 驗證

```bash
python3 /workspace/project/.claude/skills/skill-discovery/scripts/validate_skill.py \
  /workspace/project/.claude/skills/skill-name/
```

確保：
- ✓ SKILL.md 有 frontmatter
- ✓ 包含 name 和 description
- ✓ 腳本可執行
- ✓ 有使用範例

### 7. 測試

```bash
# 測試腳本
python3 /workspace/project/.claude/skills/skill-name/skill_name.py --json

# 驗證輸出格式
# 確認功能正確
```

### 8. 使用

完成後直接使用新 skill 完成使用者請求。

## 設計原則

參考 `references/skill-design-principles.md` 獲取詳細指南。

### 簡潔性

- 挑戰每個添加的必要性
- 移除 Claude 已知的內容
- 保持指令清晰簡短

### 具體性層級

- **文字指令** - 靈活任務
- **腳本** - 確定性操作
- **參考文件** - 領域知識

### 命名規範

- 資料夾：`kebab-case`（uuid-generator）
- 腳本：`snake_case`（uuid_generator.py）
- 名稱應該描述性且簡短

## 範例場景

### 場景 1: 簡單工具

**使用者：** 「生成一個 UUID」

**流程：**
1. 檢查 → 沒有 uuid 相關 skill
2. WebSearch: "Python UUID generation"
3. 初始化：`init_skill.py uuid-generator`
4. 實現：使用 Python uuid 模組
5. 驗證並測試
6. 執行並返回 UUID

**結果：**
```
.claude/skills/uuid-generator/
├── SKILL.md
└── uuid_generator.py
```

### 場景 2: 帶參考的 Skill

**使用者：** 「根據我們的品牌指南創建海報」

**流程：**
1. 初始化 skill
2. 將品牌指南放入 `references/`
3. 創建生成模板的腳本
4. SKILL.md 指示如何應用指南

**結果：**
```
.claude/skills/brand-poster/
├── SKILL.md
├── generate_poster.py
├── references/
│   └── brand-guidelines.md
└── assets/
    └── poster-template.svg
```

## 工具

### init_skill.py

初始化新 skill 結構：
```bash
python3 scripts/init_skill.py skill-name --description "..."
```

### validate_skill.py

驗證 skill 結構：
```bash
python3 scripts/validate_skill.py /path/to/skill/
```

## 重要規則

✅ **DO:**
- 在 `.claude/skills/` 下創建獨立資料夾
- 使用 init_skill.py 初始化
- 寫清楚的 description（何時使用）
- 測試後再使用
- 保持簡潔

❌ **DON'T:**
- 在 skill-discovery 內創建 skills
- 包含 Claude 已知的資訊
- 寫冗長的說明
- 跳過驗證

## 持續改進

- 觀察使用頻率
- 優化常用 skills
- 移除未使用的內容
- 合併相似功能
- 根據反饋迭代

---

記住：每個新 skill 都讓 Andrea 變得更強大。創建有價值、可重用的 skills！
