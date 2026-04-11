# 背景: NanoClaw と VRC-AI-Bot の設計思想比較

## NanoClaw — Less is More

- **チャネル非依存のルーティング**: `Channel` インターフェースで Discord/WhatsApp/Telegram 等を差し替え可能なスキルとして扱う。メッセージは `chat_jid` という統一 ID でルーティングされ、プラットフォーム差を吸収する
- **コンテナ分離**: グループごとに Claude Agent SDK を Linux コンテナで隔離実行。ファイルシステム・メモリがグループ単位で独立
- **フラットな構造**: `src/index.ts` にオーケストレーションを集約。メッセージループ → エージェント起動というシンプルなフロー
- **メッセージの最小モデル**: `NewMessage` はどのプラットフォームにも共通する最小限のフィールド（id, sender, content, timestamp）
- **トリガーベースの起動**: `TRIGGER_PATTERN` でメンションを検知し、登録済みグループにだけ応答する

## VRC-AI-Bot — コンテキスト駆動

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

## 2つのアプローチの本質的な共通点

NanoClaw の「コンテナでエージェントを物理的に分離」と VRC-AI-Bot の「型でエージェントの認知を論理的に分離」は、**同じ「エージェントに余計なことをさせない」という目的の異なるアプローチ**。

VRC-AI-Bot の型体系は NanoClaw のエージェント分離の発展形 — エージェントの役割を厳格化した結果とも読める。

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

個人用チャットボットとして、スレッドベースでマルチタスクを実現する前提での判断。

### 不要と判断したもの

- **PlaceType 7種**: 個人用には粒度が細かすぎる。アナウンスチャンネルなどはエージェントに MCP を渡して投稿させればよい
- **ActorRole**: 個人用なのでユーザー権限の区別は不要
- **Scope 3種**: 個人用なので知識の公開範囲制御は不要。全部自分のもの
- **WatchMode / channel_mode**: GroupType で代替
- **ChatBehavior の ambient_room_chat**: 個人用なので雰囲気参加は不要。メッセージが来たら確定で返信する

### 方針転換の経緯

現ブランチで `PlaceType` / `ActorRole` の型定義を VRC-AI-Bot から移植したが、検討の結果これらは不要と判断。NanoClaw の既存グループモデルの拡張で、VRC-AI-Bot が型の組み合わせでやっていたことを単一の `GroupType` プロパティとコンテナの物理的分離で表現できる。

## thread の考え方

NanoClaw における `thread` は、VRC-AI-Bot の `public_thread` / `private_thread` / `forum_post_thread` のような **Discord 上の場所の分類** をそのまま移植したものではない。

- `chat`: 永続的な会話窓口
- `thread`: 親 group から派生する、作業や委任のための会話単位

つまり `thread` は **UI 上の Discord thread というより、NanoClaw の権限・ライフサイクルモデルにおける派生 group** を表す。

Discord thread はその派生 group を表現する自然な UI として使えるが、重要なのは PlaceType の細分化ではなく、以下の 3 点。

- 親 group とは別 JID / 別 session を持つこと
- 親から必要最小限の設定だけを継承できること
- `chat` より短命で、タスク単位の作業場所として扱えること

`folder` まで分けると管理コストが急増して収拾がつかなくなるため、`thread` の分離はまず **JID と Claude session** に限定する。将来的に設定を変えたくなった場合は、**各 group ごと** に Claude の設定を切り替えられるようにする。

このため、VRC-AI-Bot の `Scope` や `ChatBehavior` を戻すのではなく、Discord adapter 側で thread を検知し、`thread_defaults` と group 自動登録で NanoClaw のモデルに落とし込むのが正しい寄せ方になる。
