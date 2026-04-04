# スレッドベースアーキテクチャ設計分析

VRC-AI-Bot の設計思想を分析し、NanoClaw の既存グループモデルを拡張してスレッドベースのマルチエージェント構造を実現する方針をまとめる。

## 背景: 2つの設計思想

### NanoClaw — Less is More

- **チャネル非依存のルーティング**: `Channel` インターフェースで Discord/WhatsApp/Telegram 等を差し替え可能なスキルとして扱う。メッセージは `chat_jid` という統一 ID でルーティングされ、プラットフォーム差を吸収する
- **コンテナ分離**: グループごとに Claude Agent SDK を Linux コンテナで隔離実行。ファイルシステム・メモリがグループ単位で独立
- **フラットな構造**: `src/index.ts` にオーケストレーションを集約。メッセージループ → エージェント起動というシンプルなフロー
- **メッセージの最小モデル**: `NewMessage` はどのプラットフォームにも共通する最小限のフィールド（id, sender, content, timestamp）
- **トリガーベースの起動**: `TRIGGER_PATTERN` でメンションを検知し、登録済みグループにだけ応答する

### VRC-AI-Bot — コンテキスト駆動

- **場所と文脈の精密なモデリング**: `PlaceType`（7種）、`ActorRole`（3段階）、`Scope`（3種）、`WatchMode`（4種）、`ChatBehavior`（2種）を組み合わせて、メッセージの「どこで・誰が・どんな文脈で」をリッチにモデル化
- **チャネルごとのモード制御**: 同じサーバー内でもチャネルを `url_watch` / `chat` / `admin_control` / `forum_longform` と使い分け
- **知識管理システム**: AI 応答から知識を抽出・永続化・検索。URL 自動収集とスコープに基づく公開範囲制御
- **多層アーキテクチャ**: Intake → Queue → Processing → Harness → Knowledge/Reply の明確なパイプライン
- **エンゲージメントポリシー**: 5段階のトリガーで Bot が「空気を読んで」返信頻度を変える

## VRC-AI-Bot の型が多い本質的理由

VRC-AI-Bot の型の多さは設計上の深い意図というより、**Codex（エージェント）がコンテキストを理解するためのハーネス入力パラメータを型として表面化させた結果**。

- `AGENTS.md` が `place`, `capabilities`, `available_context` を「system facts として扱え」と明言
- **型の粒度 = AI に渡すコンテキストの粒度**
- `ChatEngagementFact`, `RecentRoomEventFact` も AI が判断するための事実の構造化

つまり「ドメインモデリングの結果」ではなく、**「AI エージェントに正しく振る舞わせるために文脈情報を型で固めていった」**という側面が強い。

NanoClaw はコンテナ内の Claude Agent SDK に渡すのはグループごとの `CLAUDE.md` とファイルシステムであり、メッセージ型にリッチな文脈を載せる動機がそもそも薄い。**エージェントが自分の環境を見て判断する設計**。

別の見方をすると、NanoClaw の「コンテナでエージェントを物理的に分離」と VRC-AI-Bot の「型でエージェントの認知を論理的に分離」は、**同じ「エージェントに余計なことをさせない」という目的の異なるアプローチ**。VRC-AI-Bot の型体系は NanoClaw のエージェント分離の発展形 — エージェントの役割を厳格化した結果とも読める。

## VRC-AI-Bot の型定義一覧

### PlaceType（7種）

| 値 | 説明 |
|---|---|
| `guild_text` | 通常のテキストチャンネル |
| `guild_announcement` | アナウンスチャンネル |
| `chat_channel` | chat モードとして登録されたチャンネル |
| `admin_control_channel` | admin_control モードのチャンネル |
| `public_thread` | 公開スレッド |
| `private_thread` | プライベートスレッド |
| `forum_post_thread` | フォーラムのスレッド |

### Scope（3種）

| 値 | 説明 |
|---|---|
| `server_public` | サーバー全体で知識を共有 |
| `channel_family` | チャンネルファミリー内で共有 |
| `conversation_only` | その会話内のみ（非公開） |

### ChatBehavior（2種）

| 値 | 説明 |
|---|---|
| `ambient_room_chat` | 雰囲気で参加、時々返信 |
| `directed_help_chat` | 質問・メンションに集中して返信 |

## NanoClaw に必要なもの・不要なもの

個人用チャットボットとして、スレッドベースでマルチタスクを実現する前提での取捨選択。

### 不要

- **ActorRole**: 個人用なので権限ロールの区別は不要
- **Scope 3種**: 個人用なので知識の公開範囲制御は不要。全部自分のもの
- **public/private/forum スレッドの区別**: 全部 private 扱い
- **ヘルプ・アシスタントモード**: コミュニティ向け機能

### 必要

- **PlaceType（簡略化）**: `guild_text`, `guild_announcement`, `chat_channel`, `admin_control_channel`, `thread`（pub/priv/forum の区別なし）
- **ChatBehavior 2種**: `ambient_room_chat`, `directed_help_chat`

## スレッドベースのグループ拡張

### 基本方針

VRC-AI-Bot がチャネルで分けていた権限境界を、**スレッド単位に折りたたみ**、NanoClaw の既存グループモデルの拡張として実現する。

### 想定構造

```
メインスレッド（特権）
├── ファイル操作、Bash、cron ジョブ（ログ読み込み→日記作成など）
├── 他エージェントへのタスク依頼（承認ダイアログ付き）
│   └── 例: メールエージェントへの送信依頼
│       （メインエージェントはメール CLI / MCP にアクセス不可）
└── ハーネス更新、リポジトリ更新

プライベートスレッド（フル権限）
├── リポジトリ改修作業
└── ハーネス自体のメンテナンス

通常スレッド（制限付き）
├── 知見チャット（ambient_room / directed_help）
├── スコープ限定のタスク実行
└── メインからの委任タスク
```

### 既存グループモデルとの対応

```
RegisteredGroup（現状）
├── folder           → コンテナ分離（スレッドごとの隔離に流用）
├── isMain           → メインスレッドの特権フラグ
├── requiresTrigger  → 起動制御
├── containerConfig  → マウント・タイムアウト（スレッドごとの権限境界）
```

### 拡張案

```ts
// 親チャネル（テンプレート）
{
  name: "discord-main",
  folder: "discord-main",
  isMain: true,
  channel_mode: 'admin_control',
  // このチャネルから生えたスレッドの雛形
  thread_defaults: {
    channel_mode: 'chat',
    chat_behavior: 'directed_help_chat',
    containerConfig: { timeout: 300000 },
    // メール CLI のマウントなし = アクセス不可
  }
}
```

スレッドが作られると `dc:{threadId}` で子グループが自動登録され、親の `thread_defaults` を継承しつつ独自の `folder` と `CLAUDE.md` を持つ。

### 既存の仕組みがそのまま効く部分

| 既存機能 | スレッドでの活用 |
|---|---|
| コンテナ分離 | スレッドごとのエージェント権限境界 |
| `isMain` | メインスレッドの特権（Bash、ファイル操作） |
| `containerConfig.additionalMounts` | スレッドごとに何にアクセスできるか制御 |
| `folder` + `CLAUDE.md` | スレッドごとの記憶・文脈 |

### 新規に必要なもの

1. **`channel_mode` / `chat_behavior`**（現ブランチで型定義は追加済み）
2. **`thread_defaults`**（親チャネル → 子スレッドの設定継承テンプレート）
3. **スレッド検知時の自動グループ登録ロジック**

### PlaceType が不要になる可能性

`isMain` + `channel_mode` + コンテナのマウント設定で、VRC-AI-Bot が PlaceType / Scope / ActorRole の組み合わせでやっていたことを **NanoClaw の既存分離モデルの拡張として表現できる**。型で認知を制限するのではなく、コンテナで物理的に制限する NanoClaw らしいアプローチ。
