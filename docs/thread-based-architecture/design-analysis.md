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

## VRC-AI-Bot の型定義一覧（参考）

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

## NanoClaw への取捨選択

個人用チャットボットとして、スレッドベースでマルチタスクを実現する前提。

### 不要と判断したもの

- **PlaceType 7種**: 個人用には粒度が細かすぎる。アナウンスチャンネルなどはエージェントに MCP を渡して投稿させればよい
- **ActorRole**: 個人用なのでユーザー権限の区別は不要
- **Scope 3種**: 個人用なので知識の公開範囲制御は不要。全部自分のもの
- **WatchMode / channel_mode**: スレッドモードで代替

### 方針転換の経緯

現ブランチで `PlaceType` / `ActorRole` の型定義を VRC-AI-Bot から移植したが、検討の結果これらは不要と判断。NanoClaw の既存グループモデル（`isMain` + `containerConfig`）の拡張で、VRC-AI-Bot が型の組み合わせでやっていたことをコンテナの物理的分離として表現できる。

## 採用する設計: 4モードのスレッドモデル

### 権限階層

```
override  → サンドボックスなし、全ツールコール Discord に出力、一時的
main      → サンドボックスあり、特権（Bash、ファイル操作、cron）
ambient   → 雰囲気参加、制限付きコンテナ
thread    → 通常スレッド、制限付きコンテナ
```

### 各モードの役割

| モード | 説明 | ライフサイクル |
|---|---|---|
| `override` | サンドボックス解除のフル権限スレッド。スラッシュコマンドで開始/終了。全ツールコールが Discord にログ出力され、常に監視される前提 | 一時的（終了時アーカイブ） |
| `main` | メインスレッド。Bash・ファイル操作・cron ジョブの実行。他エージェントへの承認付きタスク委任 | 永続 |
| `ambient` | チャンネルの会話に雰囲気で参加。時々返信 | 永続 |
| `thread` | 通常のタスクスレッド。知見チャット、委任タスクの実行など | スレッド単位 |

### 安全策の方向性

- **main**: 「信頼してるけど箱に入れる」— サンドボックス内で特権を行使
- **override**: 「箱から出すけど全部見てる」— サンドボックスなしだが全アクションを Discord にログ出力して監視
- **ambient / thread**: コンテナのマウント設定で物理的にアクセス範囲を制限

### 既存グループモデルでの表現

```ts
// メインスレッド
{
  isMain: true,
  // → サンドボックスあり特権コンテナ
}

// オーバーライドスレッド（一時的）
{
  isMain: false,
  override: true,
  // → サンドボックスなし、ツールコールログ出力
  // → スラッシュコマンドで開始/終了
}

// 雰囲気参加
{
  chat_behavior: 'ambient',
  // → 制限付きコンテナ、時々返信
}

// 通常スレッド（デフォルト）
{
  // → 制限付きコンテナ
}
```

### スレッド自動登録

親チャネルに `thread_defaults` を設定し、スレッド作成時に `dc:{threadId}` で子グループを自動登録。親の設定を継承しつつ独自の `folder` と `CLAUDE.md` を持つ。

```ts
// 親チャネル（テンプレート）
{
  name: "discord-main",
  folder: "discord-main",
  isMain: true,
  thread_defaults: {
    chat_behavior: 'directed_help',
    containerConfig: { timeout: 300000 },
  }
}
```

### 新規に必要なもの

1. **`chat_behavior`** フィールド（`'ambient'` の追加）
2. **`override`** フラグ + ツールコールログ出力機構
3. **`thread_defaults`**（親チャネル → 子スレッドの設定継承テンプレート）
4. **スレッド検知時の自動グループ登録ロジック**
5. **スラッシュコマンド**（`/override-start`, `/override-end`）
