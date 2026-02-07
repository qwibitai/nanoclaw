# Skill Discovery & Generation

Andrea 的「自我學習」能力 - 當你要求一個不存在的功能時，自動創建新的 skill。

## 概念

**這不是一個 skills 容器，而是一個創建工具。**

當你要求新功能時，Andrea 會：
1. 檢查 `.claude/skills/` 是否已有相關 skill
2. 如果沒有，研究最佳實現方式
3. **在 `.claude/skills/` 下創建新的獨立資料夾**
4. 創建 `SKILL.md` 和腳本檔案
5. 測試並執行
6. 保存供未來使用

## 目錄結構

```
.claude/skills/
├── skill-discovery/         ← 這個管理工具
│   ├── SKILL.md
│   └── README.md
│
├── calculator/              ← 獨立的 skill
│   ├── SKILL.md
│   └── calculator.py
│
├── uuid-generator/          ← 另一個獨立 skill
│   ├── SKILL.md
│   └── uuid_gen.py
│
└── qr-code/                 ← 又一個獨立 skill
    ├── SKILL.md
    └── qr_generator.py
```

## 對使用者

你不需要做任何事！只要提出需求：

- 「幫我計算 25 的平方根」
- 「生成一個 UUID」
- 「轉換這個 JSON 格式」

Andrea 會自動處理一切。

## 對 Andrea

### 檢查現有 Skills

```bash
# 列出所有 skills
ls -d /workspace/project/.claude/skills/*/

# 搜尋功能描述
grep -r "description:" /workspace/project/.claude/skills/*/SKILL.md
```

### 創建新 Skill

```bash
# 1. 創建資料夾
mkdir -p /workspace/project/.claude/skills/new-skill-name/

# 2. 創建 SKILL.md（必須包含 frontmatter）
# 3. 實現腳本
# 4. 測試
# 5. 執行
```

### Skill 結構要求

每個 skill 必須有：
- **SKILL.md** - 包含 frontmatter (name, description) 和使用說明
- **主腳本** - Python/JS/Bash，支援 --json 輸出
- **標準輸出格式** - `{"success": true/false, "result": "...", "data": {...}}`

### 命名規範

- 資料夾：`kebab-case`（例：`uuid-generator`）
- 腳本：`snake_case`（例：`uuid_gen.py`）

## 範例

### 使用現有 Skill

使用者要求計算時，檢查並使用 calculator skill：

```bash
python3 /workspace/project/.claude/skills/calculator/calculator.py -o sqrt -n1 25 --json
```

### 創建新 Skill

使用者要求 UUID 生成（不存在）：

1. WebSearch: "Python UUID generation"
2. 創建 `/workspace/project/.claude/skills/uuid-generator/`
3. 寫 SKILL.md 和 uuid_gen.py
4. 測試並執行
5. 下次直接使用！

## 重要規則

❌ **不要**在 `skill-discovery/` 內創建 skills
✅ **要**在 `.claude/skills/` 下創建獨立資料夾
✅ **要**遵循 SKILL.md 格式規範
✅ **要**測試後再使用

## 詳細說明

請參閱 `SKILL.md` 獲取完整的工作流程和範例。
