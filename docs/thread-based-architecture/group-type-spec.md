# GroupType 仕様

VRC-AI-Bot が PlaceType / Scope / ActorRole / ChatBehavior の組み合わせでやっていたことを、NanoClaw では単一の `type` プロパティに集約する。

## 型定義

```ts
type GroupType = 'override' | 'main' | 'chat' | 'thread';
// 指定なし・不明な値 → 'chat' がデフォルト
```

## この文書の位置づけ

この文書は `GroupType` の **設計目標** を記述する。実装は段階的に追従しており、特に `thread` については「最終的に目指す姿」と「現状の実装」がまだ一致していない箇所がある。

現状の実装では `thread` は主に非特権グループとして扱われ、権限面では `chat` に近い。`thread` が `chat` と明確に違う意味を持つのは、`thread_defaults` による自動登録、親からの設定継承、別 JID / 別 session を持つ派生 group というライフサイクルが揃ってから。

## 権限階層

| type | サンドボックス | 権限 | ライフサイクル |
|---|---|---|---|
| `override` | なし | フル権限。全ツールコールが Discord にログ出力され、常に監視される前提 | 一時的（スラッシュコマンドで開始/終了、終了時アーカイブ） |
| `main` | あり | Bash、ファイル操作、cron ジョブ、他エージェントへの承認付きタスク委任 | 永続 |
| `chat` | あり | システムプロンプト読み込みのみ。メッセージが来たら必ず返信 | 永続（デフォルト） |
| `thread` | あり | 制限付きコンテナ。タスク実行用 | スレッド単位 |

## 各タイプの詳細

### `override` — 監視付きフル権限

- サンドボックスを解除した一時的なスレッド
- スラッシュコマンド (`/override-start`) で明示的に開始
- 全ツールコールが Discord にリアルタイムでログ出力される
- 終了時 (`/override-end`) にスレッドをアーカイブ
- 用途: ハーネス更新、リポジトリ改修、インフラ変更など

**安全策**: 「箱から出すけど全部見てる」— サンドボックスなしだが全アクションを Discord にログ出力して常に監視

### `main` — サンドボックス付き特権

- Bash コマンド実行、ファイルシステム操作が可能
- cron ジョブの実行基盤（ログ読み込み → 日記作成など）
- 他エージェントへの承認ダイアログ付きタスク委任
  - 例: メールエージェントへの送信依頼（メインエージェント自体はメール CLI / MCP にアクセス不可）
- 永続的に存在する

**安全策**: 「信頼してるけど箱に入れる」— サンドボックス内で特権を行使

### `chat` — 最小権限チャット（デフォルト）

- システムプロンプトの読み込みのみ可能。ツール実行不可
- メッセージが来たら確定で返信
- `type` 未指定・不明な値の場合のデフォルト
- 永続的に存在する

**安全策**: 最小権限。会話以外のことができない

### `thread` — タスク実行スレッド

- 制限付きコンテナで動作
- メインからの委任タスクの実行など
- スレッド単位で生成・破棄
- Discord の「場所の型」ではなく、親 group から派生する作業単位として扱う
- 親 group と別 JID / 別 Claude session を持つ
- 将来的には通常 group 用設定と thread 用共有設定を切り替えられる前提で設計する

**安全策**: `thread` は `main` / `override` ではない非特権 group として扱い、昇格は親 group や IPC 認可で制御する

## グループモデルでの表現

```ts
// オーバーライドスレッド（一時的フル権限）
{ type: 'override' }

// メインスレッド（特権）
{ type: 'main' }

// チャット（デフォルト、システムプロンプトのみ）
{ type: 'chat' }

// タスクスレッド
{ type: 'thread' }
```

## スレッド自動登録

親チャネルに `thread_defaults` を設定し、スレッド作成時に `dc:{threadId}` で子グループを自動登録する。親の設定を継承しつつ、親とは別の JID と Claude session を持つ。

ここで重要なのは、「Discord 上で thread だから `type: 'thread'`」ではなく、**親 group が `thread_defaults` を持つときに、その thread を NanoClaw の派生 group として採用する**こと。単なる Discord thread の存在自体は、NanoClaw の `thread` を意味しない。

```ts
// 親チャネル（テンプレート）
{
  name: "discord-main",
  folder: "discord-main",
  type: "main",
  thread_defaults: {
    type: "thread",
    containerConfig: { timeout: 300000 },
  }
}
```

## 実装に必要なもの

1. **`type` プロパティ**: `RegisteredGroup` に追加。既存の `isMain` を置換する
2. **ツールコールログ出力機構**: `override` タイプ用。全ツールコールを Discord チャンネルにリアルタイム出力
3. **`thread_defaults`**: 親チャネルから子スレッドへの設定継承テンプレート
4. **スレッド検知時の自動グループ登録ロジック**: Discord スレッド作成イベントをフックし、親の `thread_defaults` に基づいてグループを自動登録
5. **スラッシュコマンド**: `/override-start`（オーバーライドスレッド作成）、`/override-end`（終了・アーカイブ）

### 実装順序の推奨

`thread` は段階的に入れる。

1. Discord adapter が thread を正しく検知できるようにする
2. 親 group の `thread_defaults` に基づいて子 group を自動登録する
3. 子 group に独立した session を持たせる
4. 将来的に thread 用共有設定を差し替えられる形にする
5. 必要なら archive や cleanup をライフサイクルに追加する

この順序なら、VRC-AI-Bot の PlaceType モデルを持ち込まずに、NanoClaw の「group 単位の会話分離と設定分離」という哲学のまま `thread` を成立させられる。

## 設定方法: DB + IPC 拡張

`type` は既存の `isMain` と同じ方式で DB に保存する。`isMain: boolean` を `type: GroupType` に置き換える形。

### DB スキーマ変更

```sql
-- isMain を type に置換するマイグレーション
ALTER TABLE registered_groups ADD COLUMN type TEXT DEFAULT 'chat';
UPDATE registered_groups SET type = 'main' WHERE is_main = 1;
```

`is_main` DB カラムは互換性のため残し、読み込み時に `group_type` を優先する（`parseGroupType` のフォールバック）。TypeScript 側の `isMain` プロパティは削除済み。

### IPC での設定

`register_group` IPC に `group_type` フィールドを追加:

```json
{
  "type": "register_group",
  "jid": "dc:123456789",
  "name": "discord-email",
  "folder": "discord-email",
  "trigger": "!",
  "group_type": "chat"
}
```
`trigger` はエージェントを起動するメッセージのプレフィックス文字列（例: `"!"` `"@Andy"` `"always"`）で、DB の `trigger_pattern` カラムに対応する。

メインエージェントへの自然言語指示で設定する:

```
「#email チャンネルを chat タイプで登録して」
→ メインエージェントが IPC で register_group を発行
→ DB に type = 'chat' で保存
```

### IPC での type 変更制限

`override` は IPC 経由で設定不可。エージェントが自分自身を override に昇格することを防ぐ。

```ts
// ipc.ts での検証
if (data.group_type === 'override') {
  logger.warn('override type cannot be set via IPC');
  break;
}
```

`override` の設定は Discord スラッシュコマンド (`/override-start`) 経由のみ。実行できるのは許可されたユーザー ID のみ（後述）。

### 既存グループの type 変更

新しい IPC タスク `update_group` を追加:

```json
{
  "type": "update_group",
  "jid": "dc:123456789",
  "group_type": "main"
}
```

`register_group` は新規登録、`update_group` は既存グループの設定変更という棲み分け。`update_group` でも `override` への変更は拒否する。

### type ごとのデフォルト allowedTools

`agent_config` が未設定（NULL）の場合、`type` に応じてデフォルトの `allowedTools` が適用される:

| type | デフォルト allowedTools | 理由 |
|---|---|---|
| `override` | 制限なし（全許可） | サンドボックスなしのフル権限 |
| `main` | 制限なし（全許可） | Bash、ファイル操作等が必要 |
| `chat` | `["Read"]` | 会話のみ。Read はCLAUDE.md等の読み込みに必要（副作用なし）。追加ツールは `agent_config` で明示的に付与 |
| `thread` | `["Read"]` | タスクに必要なツールは `agent_config` or `thread_defaults` で付与。Read は最低限残す |

`thread` に `chat` とは別の独立パーミッション階層を持たせることはこの文書の目的ではない。差分はまずライフサイクルと session 分離に置き、必要なツール差分は将来の thread 用共有設定で表現する。

### override のライフサイクル

override はスレッド単位の一時的なフル権限セッション。

**開始**: Discord スラッシュコマンド `/override-start`
- 実行者のユーザー ID が許可リストに含まれているか検証
- 新しい Discord スレッドを作成
- `type = 'override'` でグループを DB に登録
- 全ツールコールの Discord ログ出力を有効化

**終了**: Discord スラッシュコマンド `/override-end`
- グループの `type` を `'chat'` に変更（`allowedTools: []` のため事実上無効化）
- 以降そのスレッドではメッセージを受け付けてもツール実行されない
- DB の行は残す（監査ログとして）
- Discord スレッドをアーカイブ

**異常系**:
- NanoClaw 再起動時: `type = 'override'` のグループが残っていたら、起動ログに警告を出す。自動終了はしない（意図的に継続している可能性がある）
- 終了し忘れ: 今は手動管理。将来的にタイムアウト（例: 24時間）を追加可能

**許可ユーザー管理**:

```ts
// config.ts or 環境変数
OVERRIDE_ALLOWED_USERS: string[]  // Discord ユーザー ID のリスト
```
