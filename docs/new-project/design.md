# 新プロジェクト 要件定義・設計方針

> NanoClawのコードリーディングから得た知見をベースに設計する。
> まだ要件定義フェーズ。名前未定。

---

## 前提

- **チャンネル**: Discordのみ（プライベートサーバー、身内のみ）
- **ホスト環境**: Linux
- **コンテナ**: あり（Bashコマンド・ネットワークアクセス含め全許可）
- **データベース**: SQLなし、ファイルベース（JSONL / JSON）
- **WebUI**: なし（設定変更はエージェントに頼むか手動）

---

## アーキテクチャ概要

```
Discord
  ↓ メッセージ受信
ホストプロセス
  ↓ キューイング（チャンネルごとに直列化）
コンテナ起動
  ↓ stdin経由でプロンプト送信
agent-runner（sdk/modelを見て分岐）
  ├─ sdk: "claude"    → Claude Agent SDK
  └─ sdk: "opencode"  → @opencode-ai/sdk
  ↓ 応答
stdout経由で応答受信
  ↓
Discordに送信
```

---

## チャンネル・グループ設計

### グループ = Discordチャンネル1つ

各グループは以下を持つ：

- 独立したコンテナ（ファイルシステム・セッション隔離）
- 独自の会話履歴（JSONLファイル）
- 独自の設定（`config.json`）

### isMainフラグ

NanoClawの設計を踏襲して残す。mainグループは：

- 他グループへのメッセージ送信が可能
- 全タスクの管理が可能
- グループの登録・管理が可能

プライベートサーバーのため認可チェックは最小限でよい。

**参考**: `nanoclaw/src/ipc.ts`

---

## ストレージ設計

SQLなし。全てファイルベース。

```
data/
  groups/
    {channel-name}/
      config.json          ← プロバイダー設定、トリガー設定等
      2026-03-18.jsonl     ← その日の全イベント（会話 + ツールコール）
      2026-03-19.jsonl
  tasks/
    active.json            ← アクティブなタスク一覧
    2026-03-18.jsonl       ← その日のタスク実行ログ
```

### JSONLイベント形式

1行1イベント。typeフィールドで統一。

```
{"type":"message","role":"user","content":"...","ts":1742000000}
{"type":"message","role":"assistant","content":"...","ts":1742000001}
{"type":"tool_call","tool":"bash","args":{...},"result":"...","ts":1742000002}
{"type":"tool_call","tool":"read","args":{...},"result":"...","ts":1742000003}
```

### 日付またぎの会話継続

プロバイダーへのコンテキスト構築時に「直近Nメッセージ」または「直近N日分」を読み込む。

### タスクファイル

タスクごとのファイル競合を避けるため、同時書き込みはキューで直列化。

**参考**: `nanoclaw/src/task-scheduler.ts`

---

## プロバイダー設計

### SDK構成（2本立て）

| sdk値 | 使うSDK | 対象 |
|---|---|---|
| `"claude"` | Claude Agent SDK | Claudeモデルのみ（垢バン回避のため公式SDK必須） |
| `"opencode"` | `@opencode-ai/sdk` | Copilot・Codex・Minimax等75+プロバイダー |

### config.jsonの形式

```json
{ "sdk": "claude", "model": "claude-opus-4-6" }
{ "sdk": "opencode", "model": "copilot/gpt-4" }
{ "sdk": "opencode", "model": "codex/..." }
```

`/model`コマンドで`sdk`と`model`を同時に変更する。不整合を防ぐため必ずセットで更新。

### 対応モデル例

| sdk | model例 |
|---|---|
| `claude` | `claude-opus-4-6` / `claude-sonnet-4-6` / `claude-haiku-4-5` |
| `opencode` | `copilot/gpt-4` / `copilot/gpt-4o` / `codex/...` / `minimax/...` |

### 認証フロー

**Claude Agent SDK:**
- Anthropic APIキー or OAuth（NanoClawと同方式、Credential Proxy経由）

**opencode SDK:**
1. 初回のみ `opencode` CLIで `/connect` → Device Flow等でログイン
2. トークンが `~/.local/share/opencode/auth.json` に保存される
3. SDK実行時はそのファイルを参照するだけ

---

## エージェントループ

### 方針

SDKに委譲。自前実装不要。

- `sdk: "claude"` → Claude Agent SDKのエージェントループ
- `sdk: "opencode"` → opencode SDKのエージェントループ
- 共通部分（IPCポーリング・stdout出力プロトコル）はagent-runner側で統一

### Agent Teams

不採用。

**参考（採用しないが設計理解のため）**: `nanoclaw/container/agent-runner/src/index.ts`

---

## キュー・並行制御

NanoClawのGroupQueueをほぼ流用する。

- チャンネル（グループ）ごとに同時コンテナ1つに制限
- タスクがメッセージより優先される
- 全体の同時コンテナ数上限あり（Linux・Pi環境を考慮して小さめ）
- 失敗時は指数バックオフでリトライ（最大5回）

**参考**: `nanoclaw/src/group-queue.ts`

---

## スケジュールタスク

### スケジュール種別

| タイプ | 例 | 動作 |
|---|---|---|
| `cron` | `"0 9 * * *"` | cron式で次回を計算 |
| `interval` | `"3600000"` | 前回予定時刻+ms（ドリフト防止） |
| `once` | ISO日時 | 一度だけ実行 |

### タスクの内容

- Claudeへのプロンプト（自然言語で指示）
- Bashコマンド直接実行（コンテナ内）

### タスク登録方法

エージェントにDiscordで依頼 → IPCファイル経由でホストに伝達 → `active.json`に書き込み

**参考**: `nanoclaw/src/task-scheduler.ts`

---

## IPC設計

コンテナ→ホスト間の通信はファイルベース。コンテナがJSONファイルをIPCディレクトリに置く、ホストが定期的に拾って処理する。

### コマンド種別（予定）

| type | 内容 |
|---|---|
| `schedule_task` | タスク登録 |
| `pause_task` | タスク一時停止 |
| `resume_task` | タスク再開 |
| `cancel_task` | タスク削除 |
| `update_task` | タスク更新 |
| `update_config` | プロバイダー等の設定変更（追加予定） |
| `send_message` | 他チャンネルへのメッセージ送信（mainのみ） |

**参考**: `nanoclaw/src/ipc.ts`

---

## Discordスラッシュコマンド

| コマンド | 動作 |
|---|---|
| `/new` | セッションリセット（ホスト側でセッションIDをクリア） |
| `/model` | プロバイダー切り替え（`config.json`を書き換え） |
| `/compact` | 会話履歴の圧縮（SDK依存、要検討） |

---

## メッセージフォーマット

NanoClawのXMLフォーマットを踏襲。プロバイダー問わず使える。

```xml
<context timezone="Asia/Tokyo" />
<messages>
<message sender="shin" time="09:00">おはよう</message>
</messages>
```

`<internal>...</internal>`タグはユーザーへの送信前に除去。

**参考**: `nanoclaw/src/router.ts`

---

## コンテナ設計

NanoClawのコンテナ設計を踏襲。

- コンテナ内は全権限（Bash・ネットワーク含め全許可）
- Credential Proxy経由でAPIアクセス（本物のトークンはコンテナに渡さない）
- グループフォルダをマウント（会話履歴・設定ファイルの永続化）
- mainグループはプロジェクトルートも読み取り専用でマウント

### entrypoint.shの起動フロー

```
entrypoint.sh
  ├─ opencodeサーバーをバックグラウンドで起動（常時）
  └─ agent-runner起動（sdk/modelに応じて分岐）
```

opencodeサーバーはsdkに関わらず常に起動しておく。
Claude SDKモード時はポートを使わないだけで問題ない。

**参考**: `nanoclaw/src/container-runner.ts`

---

## 未決定事項

- [ ] プロジェクト名
- [ ] `/compact`の実装方法（opencode SDK依存度による）
- [ ] Credential Proxyが本当に不要か確認（SDK内部でAPI呼び出しする場合の挙動）
- [ ] opencode SDK経由のMinimax等無料モデルの料金確認
