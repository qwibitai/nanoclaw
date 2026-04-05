# チャンネル別エージェント分離

## 動機

Discord のチャンネルごとにエージェントを分け、用途に応じてツールを制限したい。

- `#email` チャンネル → メール送受信のみ可能なエージェント
- `#rss` チャンネル → RSS フィード取得のみ可能なエージェント
- `#main` チャンネル → 特権付きメインエージェント

理想はハーネス（Claude Code インスタンス）ごと分離すること。

## 現状の NanoClaw が既に持っている分離基盤

NanoClaw のグループモデルは、既にチャンネル＝独立エージェントの素地を持つ:

| リソース | グループごとに独立？ | 根拠 |
|---|---|---|
| コンテナ | ○ | グループごとに別コンテナを起動 |
| ファイルシステム | ○ | `groups/{name}/` が独立マウント |
| CLAUDE.md | ○ | `groups/{name}/CLAUDE.md` で個別のシステムプロンプト |
| agent-runner ソース | ○ | `data/sessions/{name}/agent-runner-src/` にコピー |
| settings.json | ○ | `data/sessions/{name}/.claude/settings.json` |
| skills/ | ○ | `data/sessions/{name}/.claude/skills/` |
| セッション | ○ | グループ単位でセッション ID 管理 |
| IPC | ○ | `data/ipc/{name}/` で名前空間分離 |

**つまり、各チャンネルを別グループとして登録すれば、ハーネスごとの分離は既に実現されている。**

## 足りないもの: ツール/MCP の宣言的制限

現状、全グループが同じベースイメージ・同じツールセットで起動する。チャンネル用途に応じた制限が必要。

### 設計: `agent` プロパティ

```ts
interface RegisteredGroup {
  // ... 既存フィールド ...
  type: GroupType;                    // 'override' | 'main' | 'chat' | 'thread'
  agent?: AgentConfig;                // エージェント設定（省略時はtypeのデフォルト）
}

interface AgentConfig {
  // Claude Code の allowedTools に渡す許可リスト
  // 省略時は type に応じたデフォルト
  allowedTools?: string[];

  // MCP サーバー定義（このグループのみで有効）
  mcpServers?: Record<string, McpServerConfig>;

  // コンテナ内で利用可能なスキル（container/skills/ からの選択）
  // 省略時は全スキル同期（現状の挙動）、空配列で全スキル無効
  skills?: string[];
}

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
```

### 実装方針

ツール制限は **コンテナ起動時に `settings.json` を動的生成** することで実現する。

```
container-runner.ts: buildVolumeMounts()
  ├── 現状: 固定の settings.json を生成（全グループ共通）
  └── 変更: group.agent を見て settings.json を動的構築
        ├── allowedTools → settings.permissions.allow
        ├── mcpServers  → settings.mcpServers
        └── skills      → skills/ ディレクトリの選択的同期
```

具体的な変更箇所:

1. **`container-runner.ts` の settings.json 生成部分** (L126-148)
   - `group.agent.allowedTools` があれば `permissions.allow` に反映
   - `group.agent.mcpServers` があれば `mcpServers` に反映

2. **`container-runner.ts` の skills 同期部分** (L150-160)
   - `group.agent.skills` が指定されていれば、指定されたスキルのみ同期
   - 空配列なら何も同期しない

3. **`types.ts` に `AgentConfig` 型を追加**

### 例: チャンネル別設定

```jsonc
// #email チャンネル
{
  "name": "discord-email",
  "folder": "discord-email",
  "type": "chat",
  "agent": {
    "mcpServers": {
      "gmail": {
        "command": "npx",
        "args": ["@anthropic/gmail-mcp"]
      }
    },
    "allowedTools": ["mcp__gmail__*"],
    "skills": []
  }
}

// #rss チャンネル
{
  "name": "discord-rss",
  "folder": "discord-rss",
  "type": "chat",
  "agent": {
    "mcpServers": {
      "fetch": {
        "command": "npx",
        "args": ["@anthropic/fetch-mcp"]
      }
    },
    "allowedTools": ["mcp__fetch__*", "Read", "Write"],
    "skills": []
  }
}

// #main チャンネル
{
  "name": "discord-main",
  "folder": "discord-main",
  "type": "main"
  // agent 省略 → main のデフォルト（フル権限）
}
```

## GroupType との関係

`GroupType` は **権限の「レベル」** を決め、`agent` は **権限の「種類」** を決める。

```
GroupType (垂直方向: 何ができるか)
  override ──── サンドボックスなし、フル権限
  main ──────── Bash、ファイル操作、cron
  chat ──────── 返信のみ（デフォルト）
  thread ────── 制限付きタスク実行

agent (水平方向: 何にアクセスできるか)
  メール専用 ── Gmail MCP のみ
  RSS 専用 ─── Fetch MCP のみ
  汎用 ──────── 全ツール
```

GroupType が `chat` でも `agent` で MCP を付与すれば、「返信しかしないがメール操作はできる」エージェントが作れる。

## thread_defaults との統合

親チャネルの `thread_defaults` に `agent` を含めれば、スレッド作成時に自動で同じツール制限が適用される。

```ts
{
  name: "discord-email",
  type: "chat",
  agent: {
    mcpServers: { gmail: { ... } },
    allowedTools: ["mcp__gmail__*"],
  },
  thread_defaults: {
    type: "thread",
    agent: {
      // 親の agent を継承（明示的にオーバーライド可能）
      inherit: true
    }
  }
}
```

## セキュリティ考慮

- `agent.mcpServers` で指定される MCP コマンドは、コンテナ内で実行される（ホストではない）
- 認証情報は引き続き credential-proxy 経由で注入 — MCP サーバーが直接シークレットを持つことはない
- `allowedTools` は Claude Code の既存のパーミッションシステムに委譲
- `type: 'chat'` のグループが `agent` で Bash を許可しても、GroupType のサンドボックスポリシーが優先される（将来の実装で強制）

## 実装に必要なもの

1. **`AgentConfig` 型定義** を `types.ts` に追加
2. **`container-runner.ts` の settings.json 生成** を agent 対応に拡張
3. **`container-runner.ts` の skills 同期** を agent.skills で選択的に
4. **IPC の `register_group` / `update_group` で agent を設定** できるように
5. **thread_defaults の agent 継承ロジック**

## 設定方法: DB + IPC 拡張

`agent` 設定は `containerConfig` と同じパターンで、DB に JSON として保存する。

### DB スキーマ変更

```sql
ALTER TABLE registered_groups ADD COLUMN agent_config TEXT;
```

`agent_config` には `AgentConfig` の JSON を格納する。NULL の場合は `type` のデフォルト設定を使用。

### 保存される JSON の例

```json
{
  "allowedTools": ["mcp__gmail__*"],
  "mcpServers": {
    "gmail": {
      "command": "npx",
      "args": ["@anthropic/gmail-mcp"]
    }
  },
  "skills": []
}
```

### IPC での設定

`register_group` に `agent` フィールドを追加:

```json
{
  "type": "register_group",
  "jid": "dc:123456789",
  "name": "discord-email",
  "folder": "discord-email",
  "trigger": "!",
  "agent": {
    "allowedTools": ["mcp__gmail__*"],
    "mcpServers": {
      "gmail": { "command": "npx", "args": ["@anthropic/gmail-mcp"] }
    },
    "skills": []
  }
}
```

既存グループの agent 変更は `update_group` IPC:

```json
{
  "type": "update_group",
  "jid": "dc:123456789",
  "agent": {
    "allowedTools": ["mcp__gmail__*", "mcp__gmail__send"],
    "mcpServers": {
      "gmail": { "command": "npx", "args": ["@anthropic/gmail-mcp"] }
    }
  }
}
```

### container-runner での読み出し

`container-runner.ts` が settings.json を生成する際に、DB から `agent_config` を読む:

```
container-runner.ts: buildVolumeMounts()
  ├── DB から group.agent_config を取得
  ├── JSON.parse して AgentConfig に変換
  └── settings.json を動的構築
        ├── allowedTools → permissions.allow
        ├── mcpServers  → mcpServers
        └── skills      → skills/ の選択的同期
```

`containerConfig`（タイムアウト、追加マウント）が既に同じパターンで DB → JSON → container-runner と流れているので、`agent_config` も同じ流れに乗せる。

### 運用フロー

```
ユーザー「#email チャンネルはメール専用にして。使えるツールは Gmail MCP だけ」
  ↓
メインエージェントが IPC で register_group / update_group を発行
  ↓
DB の registered_groups.agent_config に JSON 保存
  ↓
次回コンテナ起動時に container-runner が agent_config を読んで settings.json を生成
  ↓
エージェントは Gmail MCP のみ使用可能な状態で起動
```

### thread_defaults での agent 継承

`thread_defaults` も DB に JSON で保存する（`containerConfig` と同様）:

```json
{
  "type": "update_group",
  "jid": "dc:123456789",
  "thread_defaults": {
    "type": "thread",
    "agent": {
      "inherit": true
    }
  }
}
```

`inherit: true` の場合、子スレッド作成時に親の `agent_config` をコピーする。明示的に `agent` を指定すればオーバーライド可能。
