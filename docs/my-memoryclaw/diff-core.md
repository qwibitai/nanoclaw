# 実装差分: design-core.md vs 現状NanoClaw

> design-core.md の要件に対して、現状NanoClawから何を**削除/変更/新規実装**すべきかをまとめる。

---

## 1. 削除すべきもの（NanoClawにあるがdesignでは不要）

### 1.1 マルチチャンネル基盤
| 現状 | 設計 | アクション |
|------|------|-----------|
| `src/channels/registry.ts` — 自動登録パターン | Discord固定 | **削除** — レジストリ不要、Discord直接import |
| `src/channels/index.ts` — 全チャンネルのimport集約 | — | **削除** |
| WhatsApp/Telegram/Slack/Gmail チャンネル実装 | — | **削除**（ファイルごと） |
| `Channel`インターフェースの`ownsJid()` | 単一チャンネルなのでJID所有判定不要 | **削除** |

### 1.2 SQLiteデータベース
| 現状 | 設計 | アクション |
|------|------|-----------|
| `src/db.ts` — better-sqlite3全体 | ファイルベース（JSONL/JSON） | **全面書き換え** |
| `store/` ディレクトリ | — | **削除** |
| `chats`テーブル | config.jsonの存在チェックで代替 | **削除** |
| `messages`テーブル | `data/groups/{name}/YYYY-MM-DD.jsonl` | **新規実装** |
| `registered_groups`テーブル | `data/groups/{name}/config.json`の存在 | **新規実装** |
| `sessions`テーブル | セッションID不要（messages配列を渡す） | **削除** |
| `router_state`テーブル | カーソル管理の方式変更（後述） | **削除** |

### 1.3 トリガーシステム
| 現状 | 設計 | アクション |
|------|------|-----------|
| `TRIGGER_PATTERN` (`@Andy`) | 全メッセージに反応 | **削除** |
| `ASSISTANT_NAME` | 設定としては残すがトリガー判定には使わない | **変更** |
| `requiresTrigger`フラグ | — | **削除** |
| `sender-allowlist.ts` | プライベートサーバーなので不要 | **削除** |
| `SENDER_ALLOWLIST_PATH` | — | **削除** |

### 1.4 isMainフラグ
| 現状 | 設計 | アクション |
|------|------|-----------|
| `RegisteredGroup.isMain` | 不要 | **削除** |
| main判定による権限分岐（IPC認可等） | 全グループ同権限 or 別の方式 | **簡素化** |
| mainのみプロジェクトルートマウント | 全コンテナ同一マウント構成 | **変更** |

### 1.5 macOS/WSL対応
| 現状 | 設計 | アクション |
|------|------|-----------|
| `container-runtime.ts` — プラットフォーム検出 | Linux固定 | **簡素化** |
| `detectProxyBindHost()` — macOS/WSL/Linux分岐 | docker0ブリッジIP固定 | **簡素化** |
| launchd plist（macOS） | systemd only | **削除** |

### 1.6 その他削除
| 現状 | 設計 | アクション |
|------|------|-----------|
| `remote-control.ts` | 設計に記載なし（NanoClaw固有のリモートUI機能） | **削除** |
| `mount-security.ts` / `mount-allowlist.json` | `--privileged`なし・コンテナ内は全許可なので不要 | **削除** |
| `group-folder.ts` — バリデーション | Discordチャンネル名ベースに変更 | **書き換え** |

---

## 2. 変更すべきもの（NanoClawにあり、設計で仕様変更）

### 2.1 ストレージ層（SQLite → ファイルベース）

**新しいストレージ構造:**
```
data/
  groups/
    {channel-name}/
      config.json          ← グループ設定（モデル、プロバイダー等）
      YYYY-MM-DD.jsonl     ← その日の全イベント
  tasks/
    active.json            ← アクティブなタスク一覧
    YYYY-MM-DD.jsonl       ← タスク実行ログ
```

**実装すべき新モジュール: `src/store.ts`**
- `appendEvent(groupFolder, event)` — JSONLに1行追記
- `readRecentEvents(groupFolder, limit)` — 直近N件のイベント取得
- `readTodayEvents(groupFolder)` — 今日のイベント全取得
- `loadGroupConfig(groupFolder)` — config.json読み込み
- `saveGroupConfig(groupFolder, config)` — config.json書き込み
- `listRegisteredGroups()` — config.jsonが存在するグループ一覧
- `loadActiveTasks()` / `saveActiveTasks()` — タスク管理

**JSONLイベント形式:**
```jsonl
{"type":"message","role":"user","sender":"shin","content":"...","ts":1742000000}
{"type":"message","role":"assistant","content":"...","ts":1742000001}
{"type":"tool_call","tool":"bash","args":{},"result":"...","ts":1742000002}
```

### 2.2 セッション管理（SQLite → ファイルベース）

> ⚠️ **方針確定（2026-03-20）**: Claude Agent SDKの`query()`はmessages配列を受け取れない（sessionId/resumeAt方式のみ）。また常時起動方式の維持を決定。

| 現状 | 設計 | アクション |
|------|------|-----------|
| `sessions`テーブルにClaude session IDを永続化 | `data/groups/{name}/config.json`の`sessionId`フィールドに保存 | **変更（DBからファイルへ）** |
| コンテナにsessionIdをstdin経由で渡す | 同じ（変更なし） | **維持** |
| `.claude/`ディレクトリをマウント | 同じ（変更なし） | **維持** |
| コンテナ常時起動（IDLE_TIMEOUT=30分、IPC経由で追加メッセージ送信） | 同じ（変更なし） | **維持** |

**実装ポイント:**
- `sessions`テーブルを廃止し、sessionIdは`config.json`の`sessionId`フィールドで管理
- `/new`コマンドでsessionIdをリセット（config.jsonから削除）すれば新規セッション開始
- コンテナ常時起動・IPC追加メッセージ送信の仕組みはそのまま流用

### 2.3 グループ管理（DB → ファイルシステム）

| 現状 | 設計 | アクション |
|------|------|-----------|
| `registered_groups`テーブル | `data/groups/{channel-name}/config.json`の存在 | **変更** |
| JIDベースのグループ識別 | Discordチャンネル名ベース | **変更** |
| `setRegisteredGroup()` / `getRegisteredGroup()` | ファイルI/O | **書き換え** |
| DB起動時に全グループロード | ファイルシステムスキャン | **変更** |

**config.json例:**
```json
{
  "model": "claude-sonnet-4-6",
  "provider": "claude",
  "containerConfig": {
    "timeout": 1800000
  }
}
```

### 2.4 コンテナ入出力（container-runner.ts）

**入力の変更:**
```typescript
// 現状
interface ContainerInput {
  prompt: string;        // XML形式メッセージ
  sessionId?: string;    // Claude session ID
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  // ...
}

// 設計（確定版）
interface ContainerInput {
  prompt: string;        // XML形式メッセージ（変更なし）
  sessionId?: string;    // Claude session ID（維持）
  groupFolder: string;
  chatJid: string;       // DiscordチャンネルID
  model: string;         // 使用モデル（新規）
  // isMain削除のみ（messages[]追加なし、sessionId維持）
}
```

**マウント構成の変更:**
```
現状:
  /workspace/project (ro) [mainのみ]
  /workspace/group (rw)
  /workspace/global (ro) [非main]
  /home/node/.claude (rw)
  /workspace/ipc (rw)

設計（確定版）:
  /workspace/group (rw)           ← グループフォルダ
  /home/node/.claude/projects (rw) ← セッション履歴のみ（.claude/全体は不要）
  /workspace/ipc (rw)             ← IPC
  ※ /workspace/project と /workspace/global は削除（isMain廃止のため）
  ※ /home/node/.claude 全体ではなく projects/ サブディレクトリのみマウント
```

### 2.5 メッセージループ（index.ts）

| 現状 | 設計 | アクション |
|------|------|-----------|
| 2段階カーソル（lastTimestamp + lastAgentTimestamp） | JSONL末尾から読めばよいので簡素化 | **変更** |
| `getNewMessages()` — SQLクエリ | JSONLファイルの末尾読み | **書き換え** |
| トリガー判定ロジック | 削除（全メッセージに反応） | **削除** |
| `router_state`テーブルによるカーソル永続化 | グループごとのJSONLが暗黙のカーソル | **削除** |

**新しいフロー:**
```
Discordメッセージ受信
  ↓
onMessage: JSONLに書き込み + キューに投入
  ↓
GroupQueue: 直列化
  ↓
processGroup:
  ├─ JSONLから直近の会話を読み出し
  ├─ messages配列に変換
  ├─ XMLプロンプト生成
  └─ コンテナ起動
  ↓
応答をJSONLに書き込み + Discordに送信
```

### 2.6 IPC（ipc.ts）

| 現状 | 設計 | 差分 |
|------|------|------|
| `schedule_task` | 同じ | — |
| `pause_task` | 同じ | — |
| `resume_task` | 同じ | — |
| `cancel_task` | 同じ | — |
| `update_task` | 同じ | — |
| `refresh_groups` | 不要（mainなし） | **削除** |
| `register_group` | 不要（mainなし） | **削除** |
| — | `update_config` | **新規** |
| — | `send_message` | **新規** |
| isMain認可チェック | 全グループ同権限 | **簡素化** |

---

## 3. 新規実装が必要なもの

### 3.1 Discordスラッシュコマンド

**現状:** なし（NanoClawにはDiscordスラッシュコマンド未実装）

| コマンド | 動作 | 実装内容 |
|----------|------|----------|
| `/new` | セッションリセット | グループのJSONLに区切りマーカーを書き込み、次回のmessages配列生成時に古い履歴を含めない |
| `/model` | モデル切り替え | `config.json`の`model`フィールドを書き換え |
| `/compact` | コンテキスト圧縮 | ホストプロセスがClaude APIで会話を要約 → `{"type":"summary"}` をJSONLに書き込み。`buildMessagesArray()`はsummaryを起点にする |

**実装場所:** `src/channels/discord.ts` にスラッシュコマンドハンドラを追加

### 3.2 ファイルベースストレージモジュール

**新規ファイル: `src/store.ts`**

- JSONLの読み書き（アトミック書き込み、ファイルロック考慮）
- 日付ローテーション（日付が変わったら新ファイル）
- config.jsonの読み書き
- グループ一覧の取得

### 3.3 ~~メッセージ→SDK messages配列変換~~ （削除）

> ⚠️ **2026-03-20 削除確定**: Claude Agent SDKがmessages配列を受け取れないため、この機能は不要。
> セッション管理はsessionId + resumeAt方式で行う。

### 3.4 IPC新コマンド

| コマンド | 内容 |
|----------|------|
| `update_config` | グループのconfig.jsonを書き換え（モデル変更等） |
| `send_message` | 他のDiscordチャンネルにメッセージ送信 |

### 3.5 タスクのファイルベース管理

**現状:** SQLiteの`scheduled_tasks` + `task_run_logs`テーブル

**設計:**
```
data/tasks/
  active.json           ← 全アクティブタスクの配列
  YYYY-MM-DD.jsonl      ← 実行ログ
```

`task-scheduler.ts`のDB操作を全てファイルI/Oに書き換え。

---

## 4. 流用可能なもの（変更なし or 軽微な修正）

| モジュール | 流用度 | 備考 |
|-----------|--------|------|
| `group-queue.ts` | **ロジック流用** | キュー・並行制御は流用。ただしIPC経由の追加メッセージ送信（`sendMessage`/`notifyIdle`/`closeStdin`）は削除（毎回起動方式のため） |
| `credential-proxy.ts` | **そのまま** | Credential Proxy方式は同一 |
| `router.ts` — XMLフォーマット | **そのまま** | メッセージのXMLフォーマットは踏襲 |
| `router.ts` — `<internal>`除去 | **そのまま** | |
| `container-runner.ts` — コンテナ起動基盤 | **大部分流用** | マウント構成とinput/outputの型変更のみ |
| `task-scheduler.ts` — スケジュール計算 | **ロジック流用** | `computeNextRun()`、cron-parser利用部分 |
| `ipc.ts` — ファイルベースIPC基盤 | **大部分流用** | コマンド種別の追加/削除のみ |
| `logger.ts` | **そのまま** | |
| `env.ts` | **そのまま** | |

---

## 5. テスト差分（Vitest、現状253テスト全パス）

### 5.1 全削除（不要になるテスト）

| ファイル | テスト数 | 理由 |
|----------|----------|------|
| `src/db.test.ts` | 23 | SQLite廃止 → `store.test.ts`として新規作成 |
| `src/sender-allowlist.test.ts` | 19 | sender-allowlist機能ごと削除 |
| `src/remote-control.test.ts` | 17 | remote-control機能ごと削除 |
| `src/channels/registry.test.ts` | 4 | チャンネルレジストリ廃止 |
| **計** | **63** | |

### 5.2 大幅変更（書き換え or 大部分削除）

| ファイル | テスト数 | 変更内容 |
|----------|----------|----------|
| `src/ipc-auth.test.ts` | 33 | isMain認可テスト全削除。`update_config`/`send_message`新コマンドのテスト追加 |
| `src/task-scheduler.test.ts` | 4 | DB操作→ファイルI/Oに書き換え |
| `src/group-folder.test.ts` | 5 | Discordチャンネル名ベースのバリデーションに書き換え |
| `setup/*.test.ts` | 42 | Linux/systemd固定に簡素化（macOS/WSL分岐テスト削除） |

### 5.3 軽微な変更

| ファイル | テスト数 | 変更内容 |
|----------|----------|----------|
| `src/channels/discord.test.ts` | 34 | スラッシュコマンド（`/new`, `/model`, `/compact`）のテスト追加。@mention→トリガー変換テストは削除 |
| `src/group-queue.test.ts` | 13 | `sendMessage`/`closeStdin`/`notifyIdle`関連テスト削除（毎回起動方式） |
| `src/container-runner.test.ts` | 3 | input型変更、マウント構成変更の反映 |
| `src/container-runtime.test.ts` | 8 | プラットフォーム分岐テスト削除（Linux固定） |

### 5.4 変更なし

| ファイル | テスト数 |
|----------|----------|
| `src/formatting.test.ts` | 33 |
| `src/routing.test.ts` | 8 |
| `src/credential-proxy.test.ts` | 5 |
| `src/timezone.test.ts` | 2 |

### 5.5 新規テスト

| ファイル | テスト対象 |
|----------|-----------|
| `src/store.test.ts` | JSONL読み書き、日付ローテーション、config.json操作、`listRegisteredGroups()` |
| `src/compact.test.ts` | `/compact`の要約→summaryイベント書き込み、`buildMessagesArray()`のsummary起点動作 |
| `src/session.test.ts` | JSONL→messages配列変換、`session_reset`境界、トークン上限のN件制限 |

---

## 6. 実装優先順

1. **ストレージ層**（store.ts）— 全ての土台
2. **Discord直接接続**（registry廃止、スラッシュコマンド追加）
3. **メッセージループ書き換え**（トリガー削除、JSONL読み書き）
4. **セッション管理変更**（messages配列方式）
5. **コンテナ入出力変更**（マウント簡素化、input型変更）
6. **IPC変更**（コマンド追加/削除、認可簡素化）
7. **タスクのファイルベース化**
8. **不要コード削除**（マルチチャンネル、SQLite、mount-security等）
9. **テスト**（各ステップと並行して書く。store.test.ts → session.test.ts → compact.test.ts の順）

---

## 7. リスク・注意点

- **JSONLの同時書き込み**: キュー直列化で対処するが、タスク実行とメッセージ受信が同時に書き込む可能性 → ファイルロックまたはwrite queue必要
- **JSONLのパフォーマンス**: 長期運用でファイルが大きくなる → 日付ローテーションで対処（設計済み）
- **messages配列のトークン上限**: 直近N件の"N"をどう決めるか → config.jsonで設定可能にする
- **`/compact`の要約**: ホストプロセスがHaiku（`claude-haiku-4-5`）を直呼びして要約。Credential Proxyを通す or 直接APIキーを使う必要がある
- **tool_callイベントの扱い**: messages配列方式は廃止（sessionId方式で解決済み）
