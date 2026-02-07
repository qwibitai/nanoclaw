# NanoClaw 系統操作手冊

> 版本: 1.0 | 最後更新: 2026-02-07

---

## 目錄

1. [系統概述](#1-系統概述)
2. [系統架構](#2-系統架構)
3. [環境需求](#3-環境需求)
4. [安裝部署](#4-安裝部署)
5. [環境配置](#5-環境配置)
6. [頻道管理](#6-頻道管理)
7. [Agent 技能系統](#7-agent-技能系統)
8. [排程任務管理](#8-排程任務管理)
9. [記憶系統](#9-記憶系統)
10. [安全機制](#10-安全機制)
11. [日常維運](#11-日常維運)
12. [故障排除](#12-故障排除)
13. [開發指南](#13-開發指南)
14. [測試](#14-測試)
15. [附錄](#15-附錄)

---

## 1. 系統概述

NanoClaw 是一個輕量級個人 Claude AI 助手，透過 Docker 容器安全隔離執行。支援多頻道（WhatsApp、Telegram、Discord）、多技能、排程任務，適用於 Windows 11、Linux 及 macOS。

### 1.1 核心設計理念

| 理念 | 說明 |
|------|------|
| **足夠小以理解** | 單一 Node.js 程序，少數原始碼檔案，無微服務架構 |
| **容器級隔離** | Agent 在 Docker 容器中執行，非應用層權限控制 |
| **為單一使用者打造** | 非框架或平台，而是可運作的個人軟體 |
| **AI 原生開發** | 搭配 Claude Code 使用，無需額外 UI 或監控面板 |

### 1.2 系統特色

- 多頻道支援：WhatsApp（主要）、Telegram、Discord
- 容器安全隔離：`--network=none`、`--cap-drop=ALL`、`--read-only`
- 排程任務：支援 Cron 表達式、間隔時間、一次性任務
- 記憶管理：每群組獨立的長期記憶與每日筆記
- 4 個內建 Agent 技能
- 完整的 IPC（行程間通訊）機制

---

## 2. 系統架構

### 2.1 架構圖

```
聊天應用 ──> 訊息匯流排 ──> Agent 路由器 ──> Docker 容器 ──> 回應
(WhatsApp)   (解耦合)      (佇列/IPC)      (Claude Agent SDK)
(Telegram)
(Discord)
```

### 2.2 模組說明

| 檔案 | 職責 |
|------|------|
| `src/index.ts` | 主程式：頻道設定、訊息路由、IPC 處理 |
| `src/channels/base.ts` | 頻道抽象基底類別（BaseChannel） |
| `src/channels/whatsapp.ts` | WhatsApp 頻道（Baileys） |
| `src/channels/telegram.ts` | Telegram 頻道（Bot API 長輪詢） |
| `src/channels/discord.ts` | Discord 頻道（Gateway WebSocket） |
| `src/channels/manager.ts` | 頻道管理器：路由出站訊息 |
| `src/message-bus.ts` | 解耦合的發佈/訂閱訊息匯流排 |
| `src/container-runner.ts` | 生成 Agent 容器（Docker / Apple Container） |
| `src/security.ts` | 安全控制：輸入驗證、Docker 加固、速率限制 |
| `src/memory.ts` | 每群組記憶管理（每日 + 長期） |
| `src/task-scheduler.ts` | 排程任務執行 |
| `src/db.ts` | SQLite 資料庫操作 |
| `src/config.ts` | 中央配置（環境變數） |
| `src/group-queue.ts` | 群組佇列（並發控制） |
| `src/mount-security.ts` | 掛載安全（允許清單驗證） |

### 2.3 訊息處理流程

```
1. 使用者在聊天應用發送訊息
2. 頻道（WhatsApp/Telegram/Discord）接收訊息
3. BaseChannel.emitMessage() 驗證發送者權限
4. MessageBus.publishInbound() 發佈到入站處理器
5. 入站處理器：儲存聊天元資料 + 儲存完整訊息（已註冊群組）
6. 訊息輪詢循環檢測新訊息
7. GroupQueue 管理並發：每群組一次一個 Agent
8. processGroupMessages() 組裝 XML prompt
9. runContainerAgent() 生成 Docker 容器
10. 容器內 Claude Agent SDK 處理訊息
11. Agent 回應透過 stdout JSON 返回
12. 回應透過頻道發送給使用者
```

### 2.4 資料流向

```
WhatsApp ──> BaseChannel ──> MessageBus ──> DB (messages 表)
                                              │
                              輪詢循環 <──────┘
                                  │
                            GroupQueue
                                  │
                         Container Runner
                                  │
                         Docker 容器 (Agent)
                                  │
                            stdout JSON
                                  │
                         回應 ──> WhatsApp
```

---

## 3. 環境需求

### 3.1 硬體需求

| 項目 | 最低需求 | 建議 |
|------|---------|------|
| CPU | 2 核心 | 4 核心以上 |
| 記憶體 | 2 GB | 4 GB 以上 |
| 磁碟空間 | 5 GB | 10 GB 以上 |
| 網路 | 穩定網路連線 | - |

### 3.2 軟體需求

| 項目 | 版本 | 說明 |
|------|------|------|
| Node.js | >= 20 | 執行環境 |
| Docker Desktop | 最新版 | Windows 11 / macOS |
| Docker Engine | >= 24 | Linux |
| npm | >= 10 | 套件管理 |

### 3.3 平台支援

| 平台 | 容器執行環境 | 狀態 |
|------|------------|------|
| Windows 11 | Docker Desktop | 完整支援 |
| Linux (Ubuntu/Debian) | Docker Engine | 完整支援 |
| macOS | Apple Container / Docker | 完整支援 |

---

## 4. 安裝部署

### 4.1 Windows 11 部署（Docker Compose）

```bash
# 1. 安裝先決條件
#    - 安裝 Docker Desktop：https://docker.com
#    - 安裝 Node.js 20+：https://nodejs.org

# 2. 取得程式碼
git clone https://github.com/gavrielc/nanoclaw.git
cd nanoclaw

# 3. 配置環境變數
cp .env.example .env
# 編輯 .env，填入 ANTHROPIC_API_KEY 等必要值

# 4. 使用 Docker Compose 部署
docker compose up -d

# 5. 檢查服務狀態
docker compose ps
docker compose logs -f app
```

### 4.2 Linux 部署（直接執行）

```bash
# 1. 安裝先決條件
sudo apt-get update
sudo apt-get install -y docker.io nodejs npm
sudo systemctl enable --now docker

# 2. 取得程式碼
git clone https://github.com/gavrielc/nanoclaw.git
cd nanoclaw

# 3. 配置環境變數
cp .env.example .env
# 編輯 .env

# 4. 安裝依賴並建置
npm install
npm run build

# 5. 建置 Agent 容器映像
./container/build.sh

# 6. 啟動
npm start
```

### 4.3 macOS 部署

```bash
git clone https://github.com/gavrielc/nanoclaw.git
cd nanoclaw
claude  # 使用 Claude Code，然後執行 /setup
```

### 4.4 Docker Compose 管理

```bash
docker compose up -d          # 啟動服務
docker compose logs -f app    # 即時日誌
docker compose down           # 停止服務
docker compose restart app    # 重啟服務
docker compose ps             # 查看狀態
```

---

## 5. 環境配置

### 5.1 環境變數一覽

所有配置透過 `.env` 檔案管理：

#### 必要配置

| 變數 | 說明 | 預設值 |
|------|------|--------|
| `ANTHROPIC_API_KEY` | Anthropic API 金鑰 | （必填） |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code OAuth 權杖（替代認證） | - |

#### 助手配置

| 變數 | 說明 | 預設值 |
|------|------|--------|
| `ASSISTANT_NAME` | 助手名稱（觸發詞 `@名稱`） | `Andy` |
| `CONTAINER_TIMEOUT` | 容器超時（毫秒） | `300000`（5 分鐘） |
| `MAX_CONCURRENT_CONTAINERS` | 最大並行容器數 | `5` |
| `LOG_LEVEL` | 日誌等級 | `info` |
| `TZ` | 時區 | 系統時區 |

#### 容器配置

| 變數 | 說明 | 預設值 |
|------|------|--------|
| `CONTAINER_RUNTIME` | 容器執行環境 | `docker` |
| `CONTAINER_IMAGE` | Agent 容器映像名稱 | `nanoclaw-agent:latest` |
| `CONTAINER_MAX_OUTPUT_SIZE` | 容器輸出大小限制（位元組） | `10485760`（10MB） |

#### 頻道配置

| 變數 | 說明 | 預設值 |
|------|------|--------|
| `WHATSAPP_ENABLED` | 啟用 WhatsApp | `true` |
| `TELEGRAM_ENABLED` | 啟用 Telegram | `false` |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot API Token | - |
| `TELEGRAM_ALLOWED_USERS` | 允許的 Telegram 使用者 ID（逗號分隔） | -（允許全部） |
| `DISCORD_ENABLED` | 啟用 Discord | `false` |
| `DISCORD_BOT_TOKEN` | Discord Bot Token | - |
| `DISCORD_ALLOWED_USERS` | 允許的 Discord 使用者 ID（逗號分隔） | -（允許全部） |

### 5.2 觸發規則

- 觸發模式：`@{ASSISTANT_NAME}`（不區分大小寫）
- 範例：若 `ASSISTANT_NAME=Andy`，則 `@Andy 你好` 會觸發 Agent
- 主群組（self-chat）：不需要觸發詞，所有訊息都會處理

### 5.3 關鍵目錄

| 目錄 | 說明 |
|------|------|
| `store/` | WhatsApp 認證、SQLite 資料庫 |
| `data/` | IPC 檔案、Agent 會話、環境變數 |
| `groups/` | 每群組目錄（記憶、日誌） |
| `groups/main/` | 主群組目錄 |
| `groups/global/` | 全域記憶（CLAUDE.md） |
| `container/` | Agent 容器建置檔案 |
| `container/skills/` | Agent 技能定義檔 |

---

## 6. 頻道管理

### 6.1 WhatsApp（主要頻道）

**認證流程**：
1. 首次啟動時，終端機顯示 QR 碼
2. 開啟 WhatsApp → 設定 → 連結的裝置 → 掃描 QR 碼
3. 認證資訊儲存於 `store/auth/`

**重新連線**：
- 連線斷開時自動重連（非登出）
- 若被登出，需重新掃描 QR 碼

**群組元資料同步**：
- 首次連線時同步所有群組資訊
- 每 24 小時自動同步一次

### 6.2 Telegram

**設定步驟**：
1. 在 Telegram 找到 [@BotFather](https://t.me/BotFather)
2. 發送 `/newbot` 建立新 Bot
3. 取得 Bot Token
4. 在 `.env` 設定：
   ```
   TELEGRAM_ENABLED=true
   TELEGRAM_BOT_TOKEN=你的Token
   TELEGRAM_ALLOWED_USERS=使用者ID1,使用者ID2
   ```

**工作模式**：長輪詢（30 秒超時）

### 6.3 Discord

**設定步驟**：
1. 前往 [Discord Developer Portal](https://discord.com/developers/applications)
2. 建立新 Application → Bot
3. 開啟 Message Content Intent
4. 取得 Bot Token
5. 在 `.env` 設定：
   ```
   DISCORD_ENABLED=true
   DISCORD_BOT_TOKEN=你的Token
   DISCORD_ALLOWED_USERS=使用者ID1,使用者ID2
   ```

**需要的 Intents**：GUILDS、GUILD_MESSAGES、DIRECT_MESSAGES、MESSAGE_CONTENT

### 6.4 多頻道架構

```
WhatsApp Channel ──┐
Telegram Channel ──┼──> ChannelManager ──> MessageBus ──> Agent Router
Discord Channel  ──┘
```

所有頻道實作 `BaseChannel` 抽象類別，確保統一的訊息介面。

---

## 7. Agent 技能系統

### 7.1 技能格式

技能以 Markdown 檔案定義，遵循 YAML frontmatter 格式：

```yaml
---
name: skill-name
description: "何時使用此技能的描述"
metadata: {"nanoclaw":{"emoji":"📈","schedule":"cron 表達式"}}
---

# 技能標題

技能指令內容...
```

**必要欄位**：
- `name`：技能識別碼（小寫，連字號，最多 64 字元）
- `description`：技能描述（含何時使用的觸發條件）

**選填欄位**：
- `metadata`：nanoclaw 專用元資料（emoji、排程、依賴）

### 7.2 內建技能

#### 📈 24/7 即時市場分析（market-analysis）

| 項目 | 說明 |
|------|------|
| 檔案 | `container/skills/market-analysis.md` |
| 排程 | `0 9,12,16 * * 1-5`（平日 9am、12pm、4pm） |
| 功能 | 股市監控、加密貨幣追蹤、外匯分析、新聞情緒分析、技術分析 |
| 資料來源 | Reuters、Bloomberg、CNBC（透過 web_search） |
| 安全注意 | 不提供買賣建議，僅供資訊參考 |

#### 💻 全端軟體工程師（software-engineer）

| 項目 | 說明 |
|------|------|
| 檔案 | `container/skills/software-engineer.md` |
| 功能 | 程式碼生成、程式碼審查、除錯、架構設計、測試、文件 |
| 依賴 | `node`（容器內） |
| 工作流程 | 理解 → 規劃 → 實作 → 測試 → 審查 |
| 安全標準 | 輸入驗證、參數化查詢、最小權限原則 |

#### 📋 智能日常作息管理（daily-routine）

| 項目 | 說明 |
|------|------|
| 檔案 | `container/skills/daily-routine.md` |
| 排程 | `30 7 * * 1-5`（平日 7:30am） |
| 功能 | 晨間簡報、任務管理、習慣追蹤、提醒、每日回顧、週計劃 |
| 記憶整合 | 使用 CLAUDE.md（長期）+ YYYY-MM-DD.md（每日） |

#### 🧠 個人知識助手（knowledge-assistant）

| 項目 | 說明 |
|------|------|
| 檔案 | `container/skills/knowledge-assistant.md` |
| 功能 | 知識擷取、知識檢索、研究、摘要、概念連結 |
| 研究流程 | 檢查記憶 → 網路搜尋 → 深入閱讀 → 綜合整理 → 儲存 |
| 輸出格式 | 直接回答 + 支援上下文 + 信心程度 + 來源 |

### 7.3 新增自訂技能

在 `container/skills/` 目錄建立新的 `.md` 檔案：

```yaml
---
name: my-custom-skill
description: "描述此技能的用途和觸發時機"
metadata: {"nanoclaw":{"emoji":"🔧"}}
---

# 技能標題

技能指令...
```

重建 Agent 容器以載入新技能：

```bash
./container/build.sh
```

---

## 8. 排程任務管理

### 8.1 任務類型

| 類型 | 說明 | schedule_value 範例 |
|------|------|-------------------|
| `cron` | Cron 表達式 | `0 9 * * 1-5`（平日上午 9 點） |
| `interval` | 固定間隔（毫秒） | `3600000`（每小時） |
| `once` | 一次性執行 | `2026-03-01T09:00:00Z`（ISO 時間戳） |

### 8.2 透過 IPC 管理任務

Agent 可在容器內透過 IPC 檔案系統管理任務：

**建立任務**：寫入 JSON 到 `/workspace/ipc/tasks/`
```json
{
  "type": "schedule_task",
  "prompt": "提供今日市場摘要",
  "schedule_type": "cron",
  "schedule_value": "0 9 * * 1-5",
  "targetJid": "群組JID",
  "context_mode": "group"
}
```

**暫停/恢復/取消任務**：
```json
{"type": "pause_task", "taskId": "task-xxx"}
{"type": "resume_task", "taskId": "task-xxx"}
{"type": "cancel_task", "taskId": "task-xxx"}
```

### 8.3 權限控制

| 操作 | 主群組 | 一般群組 |
|------|--------|----------|
| 為自己排程 | ✓ | ✓ |
| 為其他群組排程 | ✓ | ✗ |
| 查看所有任務 | ✓ | 僅自己的 |
| 管理其他群組任務 | ✓ | ✗ |

### 8.4 任務執行流程

```
排程輪詢（每 60 秒）
    │
    ▼
getDueTasks() 查詢到期任務
    │
    ▼
GroupQueue.enqueueTask() 加入佇列
    │
    ▼
runTask() 執行 → Docker 容器
    │
    ▼
logTaskRun() 記錄執行結果
    │
    ▼
updateTaskAfterRun() 更新 next_run
```

---

## 9. 記憶系統

### 9.1 記憶架構

```
groups/
├── main/                    # 主群組
│   ├── CLAUDE.md            # 群組上下文/指令
│   ├── memory/
│   │   ├── MEMORY.md        # 長期記憶
│   │   └── 2026-02-07.md    # 每日筆記
│   └── logs/                # 容器執行日誌
├── global/
│   └── CLAUDE.md            # 全域記憶（所有群組可讀）
└── {group-name}/
    ├── CLAUDE.md
    └── memory/
        ├── MEMORY.md
        └── YYYY-MM-DD.md
```

### 9.2 記憶類型

| 類型 | 檔案 | 用途 | 壽命 |
|------|------|------|------|
| 群組上下文 | `CLAUDE.md` | Agent 行為指令 | 永久 |
| 長期記憶 | `memory/MEMORY.md` | 重要事實和知識 | 永久 |
| 每日筆記 | `memory/YYYY-MM-DD.md` | 每日觀察和紀錄 | 永久（按日期） |
| 全域上下文 | `groups/global/CLAUDE.md` | 跨群組共享指令 | 永久 |

### 9.3 記憶隔離

- 每個群組的記憶完全隔離
- 主群組可讀寫全域記憶
- 一般群組僅可讀取全域記憶（唯讀掛載）
- 記憶檔案大小限制：10MB（超過則跳過載入）

### 9.4 上下文組裝

Agent 接收的上下文包含：
1. 長期記憶（MEMORY.md）
2. 最近 7 天的每日筆記
3. 群組 CLAUDE.md 指令
4. 最多 100 條最近訊息（防止 OOM）

---

## 10. 安全機制

### 10.1 防禦層次

```
第 1 層：輸入驗證
    ├── XML 跳脫（防止 prompt injection）
    ├── URL 驗證（防止 SSRF）
    ├── LIKE 萬用字元跳脫（防止 SQL pattern injection）
    └── 發送者權限檢查（Set O(1) 查找）

第 2 層：容器隔離
    ├── --network=none（無網路存取）
    ├── --cap-drop=ALL（移除所有 capabilities）
    ├── --read-only（唯讀根檔案系統）
    ├── --security-opt=no-new-privileges:true
    ├── --memory=1g --memory-swap=1g
    ├── --cpus=1.0
    ├── --pids-limit=256
    └── --tmpfs=/tmp:rw,noexec,nosuid,size=256m

第 3 層：掛載安全
    ├── 外部允許清單（~/.config/nanoclaw/mount-allowlist.json）
    ├── 符號連結解析（防止目錄穿越）
    └── 預設阻擋 .ssh、.gnupg、.aws 等敏感目錄

第 4 層：資料過濾
    ├── 環境變數白名單（僅 4 個變數）
    ├── 機密偵測（API key、GitHub token、AWS key 等）
    ├── 機密編輯（日誌中自動替換為 [REDACTED]）
    └── Shell 命令拒絕清單（13 個危險模式）

第 5 層：速率限制
    ├── 每發送者滑動視窗限制（預設 30 次/分鐘）
    └── 自動清理過期視窗（防止記憶體洩漏）
```

### 10.2 Shell 命令拒絕清單

| 模式 | 說明 |
|------|------|
| `rm -rf /` | 遞迴刪除根目錄 |
| `format/mkfs/diskpart` | 磁碟格式化 |
| `dd if=` | 原始磁碟寫入 |
| `:(){ ... };:` | Fork bomb |
| `shutdown/reboot/poweroff` | 系統電源 |
| `chmod 777 /` | 危險的根目錄權限變更 |
| `curl \| bash` | 管道執行遠端腳本 |
| `wget \| bash` | 管道執行遠端腳本 |
| `> /dev/sd*` | 寫入原始裝置 |
| `iptables -F` | 清除防火牆規則 |
| `passwd` | 密碼變更 |
| `useradd` | 使用者建立 |
| `chown -R / ` | 遞迴變更根目錄所有者 |

### 10.3 機密偵測類型

- API 金鑰（`sk-`開頭）
- GitHub 個人存取權杖（`ghp_`）
- GitHub OAuth 權杖（`gho_`）
- Slack 權杖（`xox[bprs]-`）
- Google API 金鑰（`AIza`開頭）
- AWS 存取金鑰（`AKIA`開頭）
- 私密金鑰（`-----BEGIN PRIVATE KEY-----`）
- 憑證（`-----BEGIN CERTIFICATE-----`）

---

## 11. 日常維運

### 11.1 啟動與停止

**Docker Compose**：
```bash
docker compose up -d     # 啟動
docker compose down      # 停止
docker compose restart   # 重啟
```

**直接執行**：
```bash
npm start                # 前景執行
npm run dev              # 開發模式（熱重載）
```

**macOS launchd**：
```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
```

### 11.2 日誌管理

**日誌等級**：`trace` < `debug` < `info` < `warn` < `error` < `fatal`

```bash
# Docker Compose 日誌
docker compose logs -f app
docker compose logs --tail=100 app

# 容器執行日誌
ls groups/{group-name}/logs/

# 設定日誌等級
LOG_LEVEL=debug npm start
```

**日誌格式**：JSON 格式（Pino），可用 `pino-pretty` 美化：
```bash
npm start | npx pino-pretty
```

### 11.3 資料庫管理

資料庫位置：`store/messages.db`（SQLite）

**資料表**：

| 表名 | 說明 |
|------|------|
| `chats` | 聊天元資料 |
| `messages` | 訊息內容 |
| `scheduled_tasks` | 排程任務 |
| `task_run_logs` | 任務執行紀錄 |
| `router_state` | 路由器狀態 |
| `sessions` | Agent 會話 |
| `registered_groups` | 已註冊群組 |

### 11.4 容器管理

```bash
# 查看執行中的容器
docker ps --filter "name=nanoclaw-"

# 查看所有 NanoClaw 容器（含已停止）
docker ps -a --filter "name=nanoclaw-"

# 手動清理停止的容器
docker rm $(docker ps -a --filter "name=nanoclaw-" -q)

# 重建 Agent 容器映像
./container/build.sh
```

### 11.5 群組管理

**註冊新群組**：透過主群組 IPC 或直接操作資料庫。

**群組目錄結構**：
```
groups/{group-name}/
├── CLAUDE.md          # 群組專屬指令
├── memory/
│   ├── MEMORY.md      # 長期記憶
│   └── 2026-02-07.md  # 每日筆記
└── logs/
    └── container-*.log  # 容器執行日誌
```

### 11.6 備份與恢復

**需要備份的目錄**：
```bash
store/          # SQLite DB + WhatsApp 認證
data/           # 會話、IPC 狀態
groups/         # 群組記憶和日誌
.env            # 環境配置（敏感！加密保存）
```

**備份範例**：
```bash
tar czf nanoclaw-backup-$(date +%Y%m%d).tar.gz \
  store/ data/ groups/ .env
```

**恢復**：
```bash
tar xzf nanoclaw-backup-YYYYMMDD.tar.gz
npm start
```

---

## 12. 故障排除

### 12.1 常見問題

#### Docker 無法啟動

```
FATAL: Docker daemon is not accessible
```

**解決方案**：
- Windows 11：確認 Docker Desktop 已啟動
- Linux：`sudo systemctl start docker`
- 確認使用者有 docker 群組權限：`sudo usermod -aG docker $USER`

#### WhatsApp QR 碼未顯示

```
WhatsApp authentication required. Run /setup in Claude Code.
```

**解決方案**：
- 確認 `WHATSAPP_ENABLED=true`
- 刪除 `store/auth/` 重新認證
- 檢查 Node.js 版本 >= 20

#### 容器超時

```
Container timed out after 300000ms
```

**解決方案**：
- 增加 `CONTAINER_TIMEOUT` 值
- 檢查 Docker 資源限制
- 查看 `groups/{group}/logs/` 中的超時日誌

#### Agent 回應解析失敗

```
Failed to parse container output
```

**解決方案**：
- 檢查容器映像是否為最新：`./container/build.sh`
- 查看容器 stderr 日誌
- 確認 Agent 容器有正確的 sentinel markers

### 12.2 效能調校

| 參數 | 預設值 | 調校建議 |
|------|--------|---------|
| `CONTAINER_TIMEOUT` | 300000 | 複雜任務可增至 600000 |
| `MAX_CONCURRENT_CONTAINERS` | 5 | 記憶體充足可增加 |
| `POLL_INTERVAL` | 2000ms | 降低可加快回應 |
| `SCHEDULER_POLL_INTERVAL` | 60000ms | 需更精確排程可降低 |
| `CONTAINER_MAX_OUTPUT_SIZE` | 10MB | 大型輸出可增加 |

### 12.3 使用 /debug 技能

在 Claude Code 中使用 `/debug` 技能可獲得互動式故障排除指引：
- 容器問題診斷
- 日誌分析
- 環境變數檢查
- 掛載配置驗證

---

## 13. 開發指南

### 13.1 本地開發

```bash
# 安裝依賴
npm install

# 開發模式（熱重載）
npm run dev

# 編譯 TypeScript
npm run build

# 型別檢查
npm run typecheck

# 程式碼格式化
npm run format
npm run format:check
```

### 13.2 專案結構

```
nanoclaw/
├── src/                    # TypeScript 原始碼
│   ├── index.ts            # 主進入點
│   ├── channels/           # 頻道實作
│   │   ├── base.ts         # 抽象基底類別
│   │   ├── whatsapp.ts     # WhatsApp
│   │   ├── telegram.ts     # Telegram
│   │   ├── discord.ts      # Discord
│   │   └── manager.ts      # 頻道管理器
│   ├── message-bus.ts      # 訊息匯流排
│   ├── container-runner.ts # 容器執行器
│   ├── security.ts         # 安全模組
│   ├── memory.ts           # 記憶管理
│   ├── task-scheduler.ts   # 排程任務
│   ├── db.ts               # 資料庫操作
│   ├── config.ts           # 配置
│   ├── group-queue.ts      # 群組佇列
│   └── mount-security.ts   # 掛載安全
├── tests/                  # 測試
│   ├── security.test.ts    # 安全模組測試（130 項）
│   ├── message-bus.test.ts # 訊息匯流排測試（15 項）
│   ├── memory.test.ts      # 記憶管理測試（39 項）
│   ├── channels.test.ts    # 頻道測試（10 項）
│   ├── config.test.ts      # 配置測試（22 項）
│   ├── db.test.ts          # 資料庫測試（27 項）
│   └── group-queue.test.ts # 群組佇列測試（14 項）
├── container/              # Agent 容器
│   ├── Dockerfile          # 容器建置檔
│   ├── build.sh            # 建置腳本
│   └── skills/             # 技能定義
├── docs/                   # 文件
├── groups/                 # 群組目錄
├── docker-compose.yml      # Docker Compose
├── Dockerfile              # 主應用容器
├── .env.example            # 環境變數範本
└── package.json            # 專案配置
```

### 13.3 新增頻道

1. 在 `src/channels/` 建立新檔案（繼承 `BaseChannel`）
2. 實作 `start()`、`stop()`、`sendMessage()` 方法
3. 在 `src/config.ts` 新增配置變數
4. 在 `src/index.ts` 的 `setupChannels()` 中註冊

### 13.4 新增技能

在 `container/skills/` 建立 YAML frontmatter 格式的 `.md` 檔案，然後重建容器。

---

## 14. 測試

### 14.1 執行測試

```bash
# 執行所有測試
npm test

# 監視模式
npm run test:watch

# 含覆蓋率
npm run test:coverage
```

### 14.2 測試概覽

| 測試檔案 | 測試數量 | 涵蓋範圍 |
|---------|---------|---------|
| `security.test.ts` | 130 | Shell 拒絕、機密偵測/編輯、容器名稱清理、環境變數過濾、速率限制、Docker 安全參數、LIKE 跳脫、URL 驗證、XML 跳脫 |
| `message-bus.test.ts` | 15 | 發佈/訂閱、錯誤隔離、處理器獨立性 |
| `memory.test.ts` | 39 | 長期記憶讀寫、每日筆記、最近記憶組裝、群組上下文 |
| `channels.test.ts` | 10 | BaseChannel 權限檢查、ChannelManager 路由 |
| `config.test.ts` | 22 | 預設值、觸發模式、頻道配置 |
| `db.test.ts` | 27 | 所有 SQLite CRUD 操作 |
| `group-queue.test.ts` | 14 | 並發控制、重試、關閉 |
| **總計** | **257** | - |

### 14.3 測試框架

- **框架**：Vitest v4
- **環境**：Node.js
- **Mock**：`vi.mock()` 模組級 Mock
- **隔離**：每個測試使用臨時目錄
- **超時**：測試 15 秒，Hook 10 秒

---

## 15. 附錄

### 15.1 資料庫 Schema

```sql
-- 聊天元資料
CREATE TABLE chats (
  jid TEXT PRIMARY KEY,
  name TEXT,
  last_message_time TEXT
);

-- 訊息
CREATE TABLE messages (
  id TEXT,
  chat_jid TEXT,
  sender TEXT,
  sender_name TEXT,
  content TEXT,
  timestamp TEXT,
  is_from_me INTEGER,
  PRIMARY KEY (id, chat_jid)
);

-- 排程任務
CREATE TABLE scheduled_tasks (
  id TEXT PRIMARY KEY,
  group_folder TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule_type TEXT NOT NULL,
  schedule_value TEXT NOT NULL,
  context_mode TEXT DEFAULT 'isolated',
  next_run TEXT,
  last_run TEXT,
  last_result TEXT,
  status TEXT DEFAULT 'active',
  created_at TEXT NOT NULL
);

-- 任務執行紀錄
CREATE TABLE task_run_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  run_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  error TEXT
);

-- 路由器狀態
CREATE TABLE router_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Agent 會話
CREATE TABLE sessions (
  group_folder TEXT PRIMARY KEY,
  session_id TEXT NOT NULL
);

-- 已註冊群組
CREATE TABLE registered_groups (
  jid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  folder TEXT NOT NULL UNIQUE,
  trigger_pattern TEXT NOT NULL,
  added_at TEXT NOT NULL,
  container_config TEXT,
  requires_trigger INTEGER DEFAULT 1
);
```

### 15.2 Docker 安全參數

```
--network=none                              # 無網路存取
--cap-drop=ALL                              # 移除所有 capabilities
--security-opt=no-new-privileges:true       # 禁止提權
--read-only                                 # 唯讀根檔案系統
--memory=1g --memory-swap=1g                # 記憶體限制 1GB
--cpus=1.0                                  # CPU 限制 1 核
--pids-limit=256                            # PID 數量限制
--tmpfs=/tmp:rw,noexec,nosuid,size=256m     # 臨時檔案系統
```

### 15.3 IPC 訊息格式

**發送訊息**：
```json
{
  "type": "message",
  "chatJid": "群組@g.us",
  "text": "訊息內容"
}
```

**排程任務**：
```json
{
  "type": "schedule_task",
  "prompt": "任務提示",
  "schedule_type": "cron|interval|once",
  "schedule_value": "表達式或毫秒",
  "targetJid": "目標群組@g.us",
  "context_mode": "group|isolated"
}
```

**任務管理**：
```json
{"type": "pause_task", "taskId": "task-xxx"}
{"type": "resume_task", "taskId": "task-xxx"}
{"type": "cancel_task", "taskId": "task-xxx"}
```

**群組管理**（僅主群組）：
```json
{"type": "refresh_groups"}
{
  "type": "register_group",
  "jid": "群組@g.us",
  "name": "群組名稱",
  "folder": "資料夾名稱",
  "trigger": "@Andy"
}
```

### 15.4 環境變數速查表

```bash
# 必要
ANTHROPIC_API_KEY=sk-ant-...

# 助手
ASSISTANT_NAME=Andy
CONTAINER_TIMEOUT=300000
MAX_CONCURRENT_CONTAINERS=5
LOG_LEVEL=info
TZ=Asia/Taipei

# 容器
CONTAINER_RUNTIME=docker
CONTAINER_IMAGE=nanoclaw-agent:latest

# WhatsApp
WHATSAPP_ENABLED=true

# Telegram
TELEGRAM_ENABLED=false
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_USERS=

# Discord
DISCORD_ENABLED=false
DISCORD_BOT_TOKEN=
DISCORD_ALLOWED_USERS=

# 其他
GATEWAY_PORT=18790
WEB_SEARCH_API_KEY=
```

---

*NanoClaw - 個人 Claude AI 助手，安全、輕量、可自訂。*
