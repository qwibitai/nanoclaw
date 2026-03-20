# NanoClaw → 新プロジェクト リファクタリング計画

## Context

NanoClawをDiscord専用・ファイルベースストレージのシンプルな構成に刷新する。マルチチャンネル基盤、SQLite、macOS/WSL対応、トリガーシステム等を削除し、Discord固定・Linux固定・JSONLストレージに置き換える。

**確定済み方針:**
- sessionId + resumeAt 方式を維持（SDKがmessages配列を受け取れないため）
- コンテナ常時起動を維持（IDLE_TIMEOUT=30分、IPC追加メッセージ送信）
- `.claude/projects/` のみマウント（セッション履歴用）
- 現リポジトリ上でブランチを切ってインプレース変更
- diff-core.md の実装優先順に従う

## ブランチ戦略

```
git checkout -b refactor/new-project
```

各ステップごとにコミット。

---

## Step 1: ストレージ層 — `src/store.ts` 新規作成

**目的:** SQLite (`src/db.ts`) を JSONL/JSON ファイルベースに置き換える土台

**新規ファイル:** `src/store.ts`

**実装する関数:**
- `appendEvent(groupFolder, event)` — JSONL に1行追記（`fs.appendFileSync`）
- `readRecentEvents(groupFolder, limit)` — 今日 + 昨日の JSONL から直近N件取得
- `readTodayEvents(groupFolder)` — 今日のイベント全取得
- `loadGroupConfig(groupFolder)` — `config.json` 読み込み
- `saveGroupConfig(groupFolder, config)` — `config.json` 書き込み（atomic write）
- `listRegisteredGroups()` — `data/groups/` 内の config.json 存在チェックでグループ一覧
- `loadActiveTasks()` / `saveActiveTasks()` — `data/tasks/active.json` の読み書き
- `appendTaskLog(event)` — `data/tasks/YYYY-MM-DD.jsonl` に追記

**ディレクトリ構造:**
```
data/
  groups/{channel-name}/
    config.json          ← グループ設定 + sessionId
    YYYY-MM-DD.jsonl     ← イベントログ
  tasks/
    active.json
    YYYY-MM-DD.jsonl
```

**config.json 形式:**
```json
{
  "model": "claude-sonnet-4-6",
  "provider": "claude",
  "sessionId": "...",
  "containerConfig": { "timeout": 1800000 }
}
```

**テスト:** `src/store.test.ts` — JSONL読み書き、日付ローテーション、config操作、listRegisteredGroups

**流用:** `src/group-folder.ts` の `isValidGroupFolder()`, `resolveGroupFolderPath()` はそのまま使う（Discordチャンネル名用にバリデーション調整のみ）

---

## Step 2: Discord直接接続 — registry廃止、スラッシュコマンド追加

**削除:**
- `src/channels/registry.ts` + `src/channels/registry.test.ts`
- `src/channels/index.ts`

**変更:** `src/channels/discord.ts`
- `registerChannel()` 呼び出しを削除、直接 export のみに
- スラッシュコマンド追加: `/new`, `/model`, `/compact`
  - `/new`: config.json の sessionId を削除 → セッションリセット
  - `/model`: config.json の model フィールドを書き換え
  - `/compact`: store.ts 経由で要約イベントを書き込み（Haiku API呼び出しはStep別）
- @mention → TRIGGER_PATTERN 変換ロジックを削除（全メッセージ反応）

**テスト:** `src/channels/discord.test.ts` にスラッシュコマンドのテスト追加、registry関連テスト削除

---

## Step 3: メッセージループ書き換え — `src/index.ts`

**変更:** `src/index.ts`
- `db.ts` import → `store.ts` import に切り替え
- `getNewMessages()` (SQLクエリ) → JSONLイベント書き込みベースに変更
- `lastTimestamp` / `lastAgentTimestamp` 2段階カーソル → 簡素化（JSONLが暗黙のカーソル）
- トリガー判定ロジック削除（全メッセージ反応）
- `channels/index.ts` barrel import → `channels/discord.ts` 直接 import
- `registeredGroups` のロード元を DB → `store.listRegisteredGroups()` に変更
- Discord の `onMessage` で JSONL にイベント書き込み + キュー投入

**流用:** `src/group-queue.ts` のキュー・並行制御はそのまま（sendMessage/notifyIdle/closeStdin も常時起動維持のため残す）

---

## Step 4: コンテナ入出力変更 — `src/container-runner.ts`

**変更:**
- `ContainerInput` から `isMain` 削除、`model` 追加
- マウント構成:
  - `/workspace/project` (ro) 削除
  - `/workspace/global` (ro) 削除
  - `/home/node/.claude` → `/home/node/.claude/projects` のみに縮小
  - `/workspace/group` (rw) 維持
  - `/workspace/ipc` (rw) 維持
- `mount-security.ts` 関連コード削除（`--privileged` なし、コンテナ内全許可）
- `sessionId` は config.json から読んで渡す（DB → ファイル）

**流用:** コンテナ起動基盤、sentinel markers、timeout処理はそのまま

---

## Step 5: IPC変更 — `src/ipc.ts`

**削除:**
- `refresh_groups` コマンド
- `register_group` コマンド
- `isMain` 認可チェック（全グループ同権限）

**新規:**
- `update_config` — config.json 書き換え
- `send_message` — 他チャンネルへのメッセージ送信

**変更:** DB操作 → store.ts のファイルI/Oに切り替え

**テスト:** `src/ipc-auth.test.ts` — isMain認可テスト全削除、新コマンドのテスト追加

---

## Step 6: タスクのファイルベース化 — `src/task-scheduler.ts`

**変更:** DB操作（`createTask`, `getAllTasks`, `getDueTasks`, `updateTask`, `deleteTask`, `logTaskRun`）→ store.ts の `loadActiveTasks()` / `saveActiveTasks()` / `appendTaskLog()` に置き換え

**流用:** `computeNextRun()`、cron-parser利用部分はそのまま

---

## Step 7: 不要コード削除

**ファイル削除:**
- `src/db.ts` + `src/db.test.ts`
- `src/sender-allowlist.ts` + `src/sender-allowlist.test.ts`
- `src/remote-control.ts` + `src/remote-control.test.ts`
- `src/mount-security.ts`
- `src/channels/registry.ts` + `src/channels/registry.test.ts`（Step 2で未削除なら）
- `src/channels/index.ts`（Step 2で未削除なら）

**簡素化:**
- `src/container-runtime.ts` — macOS/WSL分岐削除、Linux固定（docker0ブリッジIP固定）
- `src/config.ts` — `TRIGGER_PATTERN`, `SENDER_ALLOWLIST_PATH`, `MOUNT_ALLOWLIST_PATH` 削除

**依存関係削除:** `better-sqlite3` を `package.json` から削除

---

## Step 8: テスト整備

**削除済み:** db.test.ts, sender-allowlist.test.ts, remote-control.test.ts, registry.test.ts（Step 7で完了）

**新規作成:**
- `src/store.test.ts`（Step 1と並行）
- `src/compact.test.ts` — `/compact` の要約→summaryイベント書き込み

**変更:**
- `src/container-runtime.test.ts` — プラットフォーム分岐テスト削除
- `src/group-folder.test.ts` — Discordチャンネル名バリデーション
- `setup/*.test.ts` — Linux/systemd固定に簡素化

---

## 検証方法

1. **ユニットテスト:** `npm test` — 全テストパス確認
2. **ビルド:** `npm run build` — TypeScriptコンパイル成功
3. **手動テスト:**
   - `npm run dev` で起動
   - Discord でメッセージ送信 → JSONL にイベント記録確認
   - エージェント応答が返ること確認
   - `/new` → 新セッション開始確認
   - `/model` → config.json の model 変更確認
4. **コンテナ:** `./container/build.sh` → コンテナ再ビルド成功

## 主要ファイル一覧

| ファイル | アクション |
|---------|-----------|
| `src/store.ts` | **新規** |
| `src/store.test.ts` | **新規** |
| `src/index.ts` | **大幅変更** |
| `src/channels/discord.ts` | **変更**（スラッシュコマンド追加） |
| `src/container-runner.ts` | **変更**（マウント・入力型） |
| `src/ipc.ts` | **変更**（コマンド追加/削除） |
| `src/task-scheduler.ts` | **変更**（DB→ファイル） |
| `src/config.ts` | **簡素化** |
| `src/container-runtime.ts` | **簡素化** |
| `src/group-folder.ts` | **軽微変更** |
| `src/db.ts` | **削除** |
| `src/sender-allowlist.ts` | **削除** |
| `src/remote-control.ts` | **削除** |
| `src/mount-security.ts` | **削除** |
| `src/channels/registry.ts` | **削除** |
| `src/channels/index.ts` | **削除** |
