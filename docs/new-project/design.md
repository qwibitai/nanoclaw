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

### グループ登録フロー

`data/groups/{channel-name}/config.json`が存在するチャンネルのみ有効。

- メッセージが来たらチャンネルIDで`config.json`の存在チェック
- 未登録チャンネルは無視
- 登録は手動でconfigファイルを作るか、mainグループのエージェントに依頼

**参考**: `/Users/shin/src/github.com/shin902/nanoclaw/src/channels/discord.ts`（145行目）

### トリガー

全メッセージに反応（トリガーワード不要）。

### isMainフラグ

NanoClawの設計を踏襲して残す。mainグループは：

- 他グループへのメッセージ送信が可能
- 全タスクの管理が可能
- グループの登録・管理が可能

プライベートサーバーのため認可チェックは最小限でよい。

**参考**: `/Users/shin/src/github.com/shin902/nanoclaw/src/ipc.ts`

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
| `/compact` | opencode SDKの`session.summarize()`を呼ぶ（Claudeモード時は要検討） |

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

### 認証方式（SDK別）

| sdk | 認証方式 |
|---|---|
| `claude` | NanoClawと同様にCredential Proxy経由（本物のトークンをコンテナに渡さない） |
| `opencode` | Credential Proxy不要。opencodeサーバー自身が`~/.local/share/opencode/auth.json`を管理 |

**opencode SDKの場合**、opencodeサーバープロセス（Bunランタイム）がLLMプロバイダへのAPI呼び出しを直接行う。クライアント（SDK）は本物の認証情報を持たない。コンテナ内でopencodeサーバーを起動し、auth.jsonをマウントするだけでよい。

### コンテナ構成

- コンテナ内は全権限（Bash・ネットワーク含め全許可）
- **Claude SDKモード**: Credential Proxy（ホスト側）経由でAPIアクセス。本物のトークンはコンテナに渡さない
- **opencode SDKモード**: `~/.local/share/opencode/auth.json`をコンテナにマウント。opencodeサーバーが直接管理
- グループフォルダをマウント（会話履歴・設定ファイルの永続化）
- mainグループはプロジェクトルートも読み取り専用でマウント

### entrypoint.shの起動フロー

```
entrypoint.sh
  ├─ opencodeサーバーをバックグラウンドで起動（sdkに関わらず常時）
  └─ agent-runner起動（sdk/modelに応じて分岐）
      ├─ sdk: "claude"  → Claude Agent SDK（Credential Proxy経由）
      └─ sdk: "opencode" → opencode SDK（localhost:4096のopencodeサーバーに接続）
```

Claude SDKモード時もopencodeサーバーは起動したままで問題ない（ポートを使わないだけ）。

**参考**: `nanoclaw/src/container-runner.ts`

---

## セッション引き継ぎ設計

コンテナは毎回新しく起動するため、SDKにどう履歴を渡すかが課題。

### Claude SDK（`query()`）

`messages`配列をそのまま渡せる。JSONLから直近N件を読んで変換するだけ。

### opencode SDK（セッションベース）

opencodeのセッションはサーバー側で管理される。コンテナが新しく起動するたびに新セッションになるため、JSONL履歴の注入が必要。

| 方法 | 内容 | 課題 |
|---|---|---|
| **A. 初回メッセージにXML埋め込み** | NanoClawのXML形式で履歴をシステムプロンプトに詰める | トークン大量消費、コンテキスト長制限 |
| **B. summarize保存** | `/compact`で要約を保存 → 次回セッション開始時に要約をコンテキストに注入 | 要約タイミングの設計が必要 |
| **C. opencode session ID永続化** | セッションIDをJSONLに保存し、コンテナ再起動後も同じセッションに再接続 | opencodeサーバーがホスト常駐必要（コンテナ内起動だと消える） |

**採用方針**: B + A の組み合わせ
- 通常時：直近N件をXMLで注入（NanoClawと同じ）
- `/compact`実行後：要約を`summary.txt`に保存 → 次回は要約+直近数件のみ渡す

---

## 未決定事項

- [ ] プロジェクト名
- [ ] `/compact`：Claudeモード時の実装（opencode SDKは`session.summarize()`で解決済み）
- [ ] opencode SDK経由のMinimax等無料モデルの料金確認
- [ ] セッション引き継ぎ詳細実装（N件の具体的な数、要約フォーマット等）
