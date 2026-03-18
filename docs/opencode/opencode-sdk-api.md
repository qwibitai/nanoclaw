# @opencode-ai/sdk API リファレンス

> Claude Agent SDKとの比較・自作プロジェクトへの適用メモ
> ソース: https://opencode.ai/docs/ja/sdk/

---

## インストール

```bash
npm install @opencode-ai/sdk
```

バージョン: 1.2.27、MIT、外部依存なし

---

## アーキテクチャ上の重要な違い

**Claude Agent SDK**: ライブラリを直接呼び出す

```typescript
for await (const message of query({ prompt, options })) { ... }
```

**opencode SDK**: **ローカルHTTPサーバーを起動してREST/SSEで通信する**

```typescript
const server = await createOpencodeServer()   // サーバープロセス起動
const client = createOpencodeClient({ baseUrl: server.url })  // HTTP接続
await client.session.prompt(...)              // REST API呼び出し
```

→ コンテナ内でopencodeサーバーを起動する必要がある。設計に影響あり（要検討）。

---

## 初期化

```typescript
import { createOpencode, createOpencodeClient, createOpencodeServer } from "@opencode-ai/sdk"

// パターン1: サーバー+クライアント一括
const { client } = await createOpencode()

// パターン2: 既存サーバーに接続
const client = createOpencodeClient({ baseUrl: "http://localhost:4096" })
```

---

## セッション管理

```typescript
// セッション作成
const session = await client.session.create({ body: { title: "..." } })

// メッセージ送信（Claude Agent SDKのquery()相当）
const result = await client.session.prompt({
  path: { id: session.id },
  body: {
    model: { providerID: "copilot", modelID: "gpt-4" },
    parts: [{ type: "text", text: "Hello!" }]
  }
})

// セッション一覧・取得
await client.session.list()
await client.session.get({ path: { id: session.id } })
```

### セッション継続・操作

| メソッド | 内容 |
|---|---|
| `session.fork()` | 特定ポイントから新セッション作成 |
| `session.summarize()` | コンテキスト圧縮（/compactに相当） |
| `session.messages()` | 会話履歴取得 |
| `session.revert()` | 会話を巻き戻す |

---

## ストリーミング（SSEベース）

```typescript
const events = await client.event.subscribe()
for await (const event of events.stream) {
  console.log(event.type, event.properties)
}
```

主要イベント型:
- `EventMessagePartUpdated` → トークン逐次受信
- `EventMessageUpdated` → メッセージ完了
- `EventSessionUpdated` → セッション状態変化

---

## ツールコール・MCP

MCPサーバーは設定ファイル（`opencode.json`）で定義：

```json
{
  "mcp": {
    "my-tool": {
      "type": "local",
      "command": ["npx", "-y", "my-mcp-command"]
    }
  }
}
```

ToolPartの状態: `pending → running → completed | error`

---

## Claude Agent SDK との対応表

| Claude Agent SDK | opencode SDK |
|---|---|
| `query()` | `client.session.prompt()` |
| `for await (message of query(...))` | `client.event.subscribe()` + SSE |
| `sessionId` (文字列) | `session.id` (オブジェクト) |
| `allowedTools` | `opencode.json`のMCP設定 |
| `permissionMode: 'bypassPermissions'` | デフォルトで許可（要確認） |
| `mcpServers` オプション | `opencode.json`で設定 |

---

## 自作プロジェクトへの影響

opencode SDKはサーバープロセスが必要なため、コンテナ内の構成が変わる：

```
コンテナ起動
  ├─ sdk: "claude"    → Claude Agent SDK（プロセス1本）
  └─ sdk: "opencode"  → opencodeサーバー起動 + クライアント接続（プロセス2本）
```

opencodeサーバーの起動オーバーヘッドと、コンテナ内での2プロセス管理が課題。
要件が固まったら実装方針を再検討する。
