# Claude Agent SDK 徹底解説

`@anthropic-ai/claude-agent-sdk` v0.2.29–0.2.34 をリバースエンジニアリングした結果に基づき、`query()` の仕組み、エージェントチームのサブエージェントが強制終了されていた理由、およびその修正方法について解説します。公式の SDK リファレンスドキュメントの内容も補足しています。

## アーキテクチャ

```
エージェントランナー (我々のコード)
  └── query() → SDK (sdk.mjs)
        └── CLI サブプロセスを起動 (cli.js)
              └── Claude API 呼び出し、ツール実行
              └── Task ツール → サブエージェントのサブプロセスを起動
```

SDK は `cli.js` を子プロセスとして、`--output-format stream-json --input-format stream-json --print --verbose` フラグを付けて起動します。通信は標準入力/標準出力（stdin/stdout）を介した JSON-lines で行われます。

`query()` は `AsyncGenerator<SDKMessage, void>` を継承した `Query` オブジェクトを返します。内部的には：

- SDK が CLI を子プロセスとして起動し、stdin/stdout の JSON lines で通信する
- SDK の `readMessages()` が CLI の stdout から読み取り、内部ストリームにエンキューする
- `readSdkMessages()` 非同期ジェネレーターがそのストリームから yield する
- `[Symbol.asyncIterator]` が `readSdkMessages()` を返す
- CLI が stdout を閉じたときにのみ、イテレーターは `done: true` を返す

V1 (`query()`) と V2 (`createSession`/`send`/`stream`) の両方が、全く同じ 3 層アーキテクチャを使用しています：

```
SDK (sdk.mjs)           CLI プロセス (cli.js)
--------------          --------------------
XX Transport  ------>   stdin リーダー (bd1)
  (cli.js を起動)          |
$X Query      <------   stdout ライター
  (JSON-lines)             |
                        EZ() 再帰的ジェネレーター
                           |
                        Anthropic Messages API
```

## コア・エージェントループ (EZ)

CLI 内部では、エージェントループは while ループではなく、**`EZ()` と呼ばれる再帰的な非同期ジェネレーター**です：

```
EZ({ messages, systemPrompt, canUseTool, maxTurns, turnCount=1, ... })
```

各呼び出し ＝ Claude への 1 回の API 呼び出し（1 「ターン」）に相当します。

### 1 ターンごとのフロー：

1. **メッセージの準備** — コンテキストのトリミング、必要に応じてコンパクション（要約）を実行
2. **Anthropic API の呼び出し** (`mW1` ストリーミング関数を使用)
3. **レスポンスから tool_use ブロックを抽出**
4. **分岐：**
   - **tool_use ブロックがない場合** → 停止（停止フックを実行してリターン）
   - **tool_use ブロックがある場合** → ツールを実行し、turnCount をインクリメントして再帰呼び出し

エージェントループ、ツール実行、バックグラウンドタスク、チームメイトのオーケストレーションなど、すべての複雑なロジックは CLI サブプロセス内で実行されます。`query()` は薄いトランスポートラッパーに過ぎません。

## query() のオプション

公式ドキュメントにある全 `Options` 型：

| プロパティ | 型 | デフォルト | 説明 |
|----------|------|---------|-------------|
| `abortController` | `AbortController` | `new AbortController()` | 操作をキャンセルするためのコントローラー |
| `additionalDirectories` | `string[]` | `[]` | Claude がアクセスできる追加ディレクトリ |
| `agents` | `Record<string, AgentDefinition>` | `undefined` | プログラムでサブエージェントを定義（エージェントチームではなく、オーケストレーションなし） |
| `allowDangerouslySkipPermissions` | `boolean` | `false` | `permissionMode: 'bypassPermissions'` を使用する場合に必須 |
| `allowedTools` | `string[]` | 全ツール | 許可されるツール名のリスト |
| `betas` | `SdkBeta[]` | `[]` | ベータ機能（例：1M コンテキスト用の `['context-1m-2025-08-07']`） |
| `canUseTool` | `CanUseTool` | `undefined` | ツール使用のためのカスタム権限関数 |
| `continue` | `boolean` | `false` | 直近の会話を継続する |
| `cwd` | `string` | `process.cwd()` | 作業ディレクトリ |
| `disallowedTools` | `string[]` | `[]` | 許可しないツール名のリスト |
| `enableFileCheckpointing` | `boolean` | `false` | 巻き戻し（rewind）用のファイル変更追跡を有効にする |
| `env` | `Dict<string>` | `process.env` | 環境変数 |
| `executable` | `'bun' \| 'deno' \| 'node'` | 自動検出 | JavaScript ランタイム |
| `fallbackModel` | `string` | `undefined` | プライマリモデルが失敗したときに使用するモデル |
| `forkSession` | `boolean` | `false` | 再開時にオリジナルを継続せず、新しいセッション ID に分岐する |
| `hooks` | `Partial<Record<HookEvent, HookCallbackMatcher[]>>` | `{}` | イベント用のフックコールバック |
| `includePartialMessages` | `boolean` | `false` | 部分的なメッセージイベントを含める（ストリーミング） |
| `maxBudgetUsd` | `number` | `undefined` | クエリの最大予算 (USD) |
| `maxThinkingTokens` | `number` | `undefined` | 思考プロセス（thinking）に使用する最大トークン数 |
| `maxTurns` | `number` | `undefined` | 最大会話ターン数 |
| `mcpServers` | `Record<string, McpServerConfig>` | `{}` | MCP サーバーの設定 |
| `model` | `string` | CLI のデフォルト | 使用する Claude モデル |
| `outputFormat` | `{ type: 'json_schema', schema: JSONSchema }` | `undefined` | 構造化出力形式 |
| `pathToClaudeCodeExecutable` | `string` | 内蔵を使用 | Claude Code 実行ファイルのパス |
| `permissionMode` | `PermissionMode` | `'default'` | 権限モード |
| `plugins` | `SdkPluginConfig[]` | `[]` | ローカルパスからカスタムプラグインをロード |
| `resume` | `string` | `undefined` | 再開するセッション ID |
| `resumeSessionAt` | `string` | `undefined` | 特定のメッセージ UUID からセッションを再開 |
| `sandbox` | `SandboxSettings` | `undefined` | サンドボックスの動作設定 |
| `settingSources` | `SettingSource[]` | `[]` (なし) | ロードする設定ファイルのソース。CLAUDE.md をロードするには `'project'` を含める必要あり |
| `stderr` | `(data: string) => void` | `undefined` | 標準エラー出力（stderr）用のコールバック |
| `systemPrompt` | `string \| { type: 'preset'; preset: 'claude_code'; append?: string }` | `undefined` | システムプロンプト。preset を使用すると Claude Code のプロンプトを取得でき、`append` で追記可能 |
| `tools` | `string[] \| { type: 'preset'; preset: 'claude_code' }` | `undefined` | ツールの設定 |

### PermissionMode

```typescript
type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
```

### SettingSource

```typescript
type SettingSource = 'user' | 'project' | 'local';
// 'user'    → ~/.claude/settings.json
// 'project' → .claude/settings.json (バージョン管理対象)
// 'local'   → .claude/settings.local.json (gitignored)
```

省略した場合、SDK は設定ファイルを一切ロードしません（デフォルトで隔離）。優先順位： local > project > user。プログラムによるオプションは常に設定ファイルを上書きします。

### AgentDefinition

プログラムによるサブエージェント（エージェントチームでは「ない」 — より単純で、エージェント間の調整機能はありません）：

```typescript
type AgentDefinition = {
  description: string;  // このエージェントをいつ使用すべきか
  tools?: string[];     // 許可されるツール（省略時はすべて継承）
  prompt: string;       // エージェントのシステムプロンプト
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';
}
```

### McpServerConfig

```typescript
type McpServerConfig =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'sse'; url: string; headers?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | { type: 'sdk'; name: string; instance: McpServer }  // プロセス内実行
```

### SdkBeta

```typescript
type SdkBeta = 'context-1m-2025-08-07';
// Opus 4.6, Sonnet 4.5, Sonnet 4 で 1M トークンのコンテキストウィンドウを有効にする
```

### CanUseTool

```typescript
type CanUseTool = (
  toolName: string,
  input: ToolInput,
  options: { signal: AbortSignal; suggestions?: PermissionUpdate[] }
) => Promise<PermissionResult>;

type PermissionResult =
  | { behavior: 'allow'; updatedInput: ToolInput; updatedPermissions?: PermissionUpdate[] }
  | { behavior: 'deny'; message: string; interrupt?: boolean };
```

## SDKMessage の型

`query()` は 16 種類のメッセージ型を yield する可能性があります。公式ドキュメントには簡略化された 7 種類のみ記載されていますが、`sdk.d.ts` には全セットが定義されています：

| 型 | サブタイプ | 目的 |
|------|---------|---------|
| `system` | `init` | セッションが初期化された。session_id, ツール、モデルを含む |
| `system` | `task_notification` | バックグラウンドエージェントが完了/失敗/停止した |
| `system` | `compact_boundary` | 会話がコンパクション（要約）された |
| `system` | `status` | ステータスの変更（例：要約中） |
| `system` | `hook_started` | フックの実行が開始された |
| `system` | `hook_progress` | フックの進捗出力 |
| `system` | `hook_response` | フックが完了した |
| `system` | `files_persisted` | ファイルが保存された |
| `assistant` | — | Claude のレスポンス（テキスト + ツール呼び出し） |
| `user` | — | ユーザーメッセージ（内部用） |
| `user` (replay) | — | 再開時にリプレイされたユーザーメッセージ |
| `result` | `success` / `error_*` | プロンプト処理ラウンドの最終結果 |
| `stream_event` | — | 部分的なストリーミング（includePartialMessages が有効な場合） |
| `tool_progress` | — | 長時間実行されるツールの進捗 |
| `auth_status` | — | 認証状態の変更 |
| `tool_use_summary` | — | 直前のツール使用の要約 |

### SDKTaskNotificationMessage (sdk.d.ts:1507)

```typescript
type SDKTaskNotificationMessage = {
  type: 'system';
  subtype: 'task_notification';
  task_id: string;
  status: 'completed' | 'failed' | 'stopped';
  output_file: string;
  summary: string;
  uuid: UUID;
  session_id: string;
};
```

### SDKResultMessage (sdk.d.ts:1375)

2 つのバリアントがあり、共通のフィールドを持ちます：

```typescript
// 両バリアント共通のフィールド：
// uuid, session_id, duration_ms, duration_api_ms, is_error, num_turns,
// total_cost_usd, usage: NonNullableUsage, modelUsage, permission_denials

// 成功：
type SDKResultSuccess = {
  type: 'result';
  subtype: 'success';
  result: string;
  structured_output?: unknown;
  // ...共通フィールド
};

// エラー：
type SDKResultError = {
  type: 'result';
  subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries';
  errors: string[];
  // ...共通フィールド
};
```

結果に含まれる有用なフィールド： `total_cost_usd`, `duration_ms`, `num_turns`, `modelUsage` (`costUSD`, `inputTokens`, `outputTokens`, `contextWindow` を含むモデルごとの内訳)。

### SDKAssistantMessage

```typescript
type SDKAssistantMessage = {
  type: 'assistant';
  uuid: UUID;
  session_id: string;
  message: APIAssistantMessage; // Anthropic SDK から
  parent_tool_use_id: string | null; // サブエージェントからの場合は非 null
};
```

### SDKSystemMessage (init)

```typescript
type SDKSystemMessage = {
  type: 'system';
  subtype: 'init';
  uuid: UUID;
  session_id: string;
  apiKeySource: ApiKeySource;
  cwd: string;
  tools: string[];
  mcp_servers: { name: string; status: string }[];
  model: string;
  permissionMode: PermissionMode;
  slash_commands: string[];
  output_style: string;
};
```

## ターンの動作：エージェントが停止する場合と継続する場合

### エージェントが停止（STOP）する場合 (API 呼び出しが終了)

**1. レスポンスに tool_use ブロックがない場合（主要なケース）**

Claude がテキストのみで回答した — タスクが完了したと判断した。API の `stop_reason` は `"end_turn"` になります。SDK はこの判断を行わず、完全に Claude モデルの出力によって駆動されます。

**2. 最大ターン数を超えた場合** — `subtype: "error_max_turns"` の `SDKResultError` が返されます。

**3. アボートシグナル** — `abortController` を介したユーザーによる中断。

**4. 予算を超えた場合** — `totalCost >= maxBudgetUsd` → `"error_max_budget_usd"`。

**5. 停止フックが継続を阻止した場合** — フックが `{preventContinuation: true}` を返した場合。

### エージェントが継続（CONTINUE）する場合 (再度 API 呼び出しを行う)

**1. レスポンスに tool_use ブロックが含まれる場合（主要なケース）** — ツールを実行し、turnCount をインクリメントして `EZ` を再帰呼び出しします。

**2. max_output_tokens 回復** — 「作業をより細かく分割してください」というコンテキストメッセージとともに、最大 3 回までリトライします。

**3. 停止フックのブロッキングエラー** — エラーがコンテキストメッセージとしてフィードバックされ、ループが継続します。

**4. モデルのフォールバック** — フォールバックモデルでリトライします（1 回限り）。

### 判断表

| 条件 | アクション | 結果の型 |
|-----------|--------|-------------|
| レスポンスに `tool_use` ブロックあり | ツールを実行し、`EZ` を再帰呼び出し | 継続 |
| レスポンスに `tool_use` ブロックなし | 停止フックを実行し、リターン | `success` |
| `turnCount > maxTurns` | max_turns_reached を yield | `error_max_turns` |
| `totalCost >= maxBudgetUsd` | 予算エラーを yield | `error_max_budget_usd` |
| `abortController.signal.aborted` | 中断メッセージを yield | コンテキストに依存 |
| `stop_reason === "max_tokens"` (出力) | 回復プロンプトで最大 3 回リトライ | 継続 |
| 停止フック `preventContinuation` | 即座にリターン | `success` |
| 停止フックのブロッキングエラー | エラーをフィードバックし、再帰呼び出し | 継続 |
| モデルフォールバックエラー | フォールバックモデルでリトライ（1回限り） | 継続 |

## サブエージェントの実行モード

### ケース 1: 同期サブエージェント (`run_in_background: false`) — ブロック

親エージェントが Task ツールを呼び出す → `VR()` がサブエージェント用に `EZ()` を実行 → 親は最終結果を待つ → ツール結果が親に返される → 親が継続。

サブエージェントは再帰的な EZ ループを完全に実行します。親のツール実行は `await` によって一時停止されます。実行途中の「昇格」メカニズムが存在します。同期サブエージェントは、`backgroundSignal` プロミスに対する `Promise.race()` によってバックグラウンドへ昇格させることができます。

### ケース 2: バックグラウンドタスク (`run_in_background: true`) — 待機しない

- **Bash ツール:** コマンドが起動され、ツールは空の結果 + `backgroundTaskId` を伴って即座に返ります。
- **Task/Agent ツール:** サブエージェントが投げっぱなし（fire-and-forget）ラッパー (`g01()`) 内で起動され、ツールは `status: "async_launched"` + `outputFile` パスを伴って即座に返ります。

`type: "result"` メッセージを出力する前に「バックグラウンドタスクを待つ」ロジックは一切ありません。バックグラウンドタスクが完了すると、`SDKTaskNotificationMessage` が別途出力されます。

### ケース 3: エージェントチーム (TeammateTool / SendMessage) — 結果が先、その後にポーリング

チームリーダーは通常の EZ ループを実行し、その中でチームメイトを起動します。リーダーの EZ ループが終了すると、`type: "result"` が出力されます。その後、リーダーは結果出力後のポーリングループに入ります：

```javascript
while (true) {
    // アクティブなチームメイト「かつ」実行中のタスクがないか確認 → ループを抜ける
    // チームメイトからの未読メッセージを確認 → 新しいプロンプトとして再注入し、EZ ループを再開
    // アクティブなチームメイトがいる状態で stdin が閉じられた場合 → シャットダウンプロンプトを注入
    // 500ms ごとにポーリング
}
```

SDK 利用側の視点： 最初の `type: "result"` を受信した後も、チームリーダーがチームメイトの応答を処理してエージェントループに再突入するため、AsyncGenerator はさらにメッセージを yield し続ける可能性があります。ジェネレーターが真に終了するのは、すべてのチームメイトがシャットダウンしたときのみです。

## isSingleUserTurn 問題

sdk.mjs より：

```javascript
QK = typeof X === "string"  // プロンプトが文字列の場合、isSingleUserTurn = true
```

`isSingleUserTurn` が true であり、最初の `result` メッセージが届いたとき：

```javascript
if (this.isSingleUserTurn) {
  this.transport.endInput();  // CLI への stdin を閉じる
}
```

これにより連鎖反応が起こります：

1. SDK が CLI の stdin を閉じる
2. CLI が stdin のクローズを検出
3. ポーリングループが、アクティブなチームメイトがいる状態で `D = true` (stdin クローズ) を検知
4. シャットダウンプロンプトを注入 → リーダーがすべてのチームメイトに `shutdown_request` を送信
5. **チームメイトが調査の途中で強制終了される**

シャットダウンプロンプト（難読化された cli.js 内の `BGq` 変数に存在）：

```
あなたは非対話モードで実行されており、チームがシャットダウンされるまで
ユーザーにレスポンスを返すことはできません。

最終的なレスポンスを準備する前に、必ずチームをシャットダウンしなければなりません：
1. requestShutdown を使用して、各チームメンバーに正常なシャットダウンを依頼する
2. シャットダウンの承認を待つ
3. cleanup 操作を使用して、チームをクリーンアップする
4. その後で初めて、ユーザーに最終的なレスポンスを提供する
```

### 実用上の問題

V1 `query()` + 文字列プロンプト + エージェントチームを使用した場合：

1. リーダーがチームメイトを起動し、彼らが調査を開始する
2. リーダーの EZ ループが終了（「チームを派遣しました、現在作業中です」）
3. `type: "result"` が出力される
4. SDK が `isSingleUserTurn = true` を見て、即座に stdin を閉じる
5. ポーリングループが stdin のクローズ + アクティブなチームメイトを検出し、シャットダウンプロンプトを注入
6. リーダーがすべてのチームメイトに `shutdown_request` を送信
7. **チームメイトは 5 分の調査タスクの開始 10 秒後であっても、停止を命じられる**

## 修正方法：ストリーミング入力モード

文字列プロンプト（`isSingleUserTurn = true` になる）を渡す代わりに、`AsyncIterable<SDKUserMessage>` を渡します：

```typescript
// 修正前 (エージェントチームで問題が発生)：
query({ prompt: "何かして" })

// 修正後 (CLI を維持)：
query({ prompt: asyncIterableOfMessages })
```

プロンプトが `AsyncIterable` の場合：
- `isSingleUserTurn = false` となる
- SDK は最初の結果の後に stdin を閉じない
- CLI は生存し続け、処理を継続する
- バックグラウンドエージェントは実行を継続する
- `task_notification` メッセージがイテレーターを通じて流れる
- イテラブルをいつ終了させるかは、我々が制御できる

### 追加のメリット：新着メッセージのストリーミング

非同期イテラブルのアプローチを使用すると、エージェントが作業している間に、新しく届いた WhatsApp メッセージをイテラブルにプッシュできます。コンテナが終了するまでメッセージをキューに入れ、新しいコンテナを起動する代わりに、実行中のセッションに直接ストリーミングできます。

### エージェントチームにおける意図されたライフサイクル

非同期イテラブルによる修正 (`isSingleUserTurn = false`) を行うと、stdin が開いたままになるため、CLI がチームメイトチェックやシャットダウンプロンプト注入に陥ることはありません：

```
1. system/init          → セッション初期化
2. assistant/user       → Claude の思考、ツール呼び出し、ツール結果
3. ...                  → さらなる assistant/user ターン (サブエージェントの起動など)
4. result #1            → リーダーエージェントの最初のレスポンス (捕捉)
5. task_notification(s) → バックグラウンドエージェントの完了/失敗/停止
6. assistant/user       → リーダーエージェントが継続 (サブエージェントの結果を処理)
7. result #2            → リーダーエージェントの追撃レスポンス (捕捉)
8. [iterator done]      → CLI が stdout を閉じ、すべて完了
```

すべての結果（result）には意味があります。最初だけでなく、すべてを捕捉してください。

## V1 vs V2 API

### V1: `query()` — 1 回限りの非同期ジェネレーター

```typescript
const q = query({ prompt: "...", options: {...} });
for await (const msg of q) { /* イベントを処理 */ }
```

- `prompt` が文字列の場合： `isSingleUserTurn = true` → 最初の結果の後に stdin が自動的に閉じる
- マルチターンの場合： `AsyncIterable<SDKUserMessage>` を渡し、自身で調整を管理する必要がある

### V2: `createSession()` + `send()` / `stream()` — 永続セッション

```typescript
await using session = unstable_v2_createSession({ model: "..." });
await session.send("最初のメッセージ");
for await (const msg of session.stream()) { /* イベント */ }
await session.send("追撃メッセージ");
for await (const msg of session.stream()) { /* イベント */ }
```

- 常に `isSingleUserTurn = false` → stdin は開いたまま
- `send()` は非同期キュー (`QX`) にエンキューする
- `stream()` は同じメッセージジェネレーターから yield し、`result` 型で停止する
- `send()` と `stream()` を交互に呼び出すだけで、自然にマルチターンが可能
- V2 は内部で V1 `query()` を呼び出さない — 両方が独立して Transport と Query を作成する

### 比較表

| 特徴 | V1 | V2 |
|--------|----|----|
| `isSingleUserTurn` | 文字列プロンプトの場合 `true` | 常に `false` |
| マルチターン | `AsyncIterable` の管理が必要 | `send()`/`stream()` を呼ぶだけ |
| stdin ライフサイクル | 最初の結果の後に自動クローズ | `close()` まで開いたまま |
| エージェントループ | 同一の `EZ()` | 常に同一の `EZ()` |
| 停止条件 | 同じ | 同様 |
| セッションの永続性 | 新しい `query()` に `resume` を渡す必要あり | セッションオブジェクトに内蔵 |
| API の安定性 | 安定版 | 不安定なプレビュー (`unstable_v2_*` プレフィックス) |

**重要な発見：ターンの動作に違いはありません。** 両方とも同じ CLI プロセス、同じ `EZ()` 再帰的ジェネレーター、および同じ判断ロジックを使用しています。

## フックイベント (Hook Events)

```typescript
type HookEvent =
  | 'PreToolUse'         // ツール実行前
  | 'PostToolUse'        // ツール実行成功後
  | 'PostToolUseFailure' // ツール実行失敗後
  | 'Notification'       // 通知メッセージ
  | 'UserPromptSubmit'   // ユーザープロンプト送信時
  | 'SessionStart'       // セッション開始 (起動/再開/クリア/要約)
  | 'SessionEnd'         // セッション終了時
  | 'Stop'               // エージェント停止時
  | 'SubagentStart'      // サブエージェント起動時
  | 'SubagentStop'       // サブエージェント停止時
  | 'PreCompact'         // 会話のコンパクション前
  | 'PermissionRequest'; // 権限リクエスト時
```

### フックの設定

```typescript
interface HookCallbackMatcher {
  matcher?: string;      // オプション：ツール名のマッチャー
  hooks: HookCallback[];
}

type HookCallback = (
  input: HookInput,
  toolUseID: string | undefined,
  options: { signal: AbortSignal }
) => Promise<HookJSONOutput>;
```

### フックの戻り値

```typescript
type HookJSONOutput = AsyncHookJSONOutput | SyncHookJSONOutput;

type AsyncHookJSONOutput = { async: true; asyncTimeout?: number };

type SyncHookJSONOutput = {
  continue?: boolean;
  suppressOutput?: boolean;
  stopReason?: string;
  decision?: 'approve' | 'block';
  systemMessage?: string;
  reason?: string;
  hookSpecificOutput?:
    | { hookEventName: 'PreToolUse'; permissionDecision?: 'allow' | 'deny' | 'ask'; updatedInput?: Record<string, unknown> }
    | { hookEventName: 'UserPromptSubmit'; additionalContext?: string }
    | { hookEventName: 'SessionStart'; additionalContext?: string }
    | { hookEventName: 'PostToolUse'; additionalContext?: string };
};
```

### サブエージェントフック (`sdk.d.ts` より)

```typescript
type SubagentStartHookInput = BaseHookInput & {
  hook_event_name: 'SubagentStart';
  agent_id: string;
  agent_type: string;
};

type SubagentStopHookInput = BaseHookInput & {
  hook_event_name: 'SubagentStop';
  stop_hook_active: boolean;
  agent_id: string;
  agent_transcript_path: string;
  agent_type: string;
};

// BaseHookInput = { session_id, transcript_path, cwd, permission_mode? }
```

## Query インターフェースのメソッド

`Query` オブジェクト (sdk.d.ts:931)。公式ドキュメントに記載されている公開メソッド：

```typescript
interface Query extends AsyncGenerator<SDKMessage, void> {
  interrupt(): Promise<void>;                     // 現在の実行を停止（ストリーミング入力モードのみ）
  rewindFiles(userMessageUuid: string): Promise<void>; // ファイルを指定したメッセージ時の状態に復元（enableFileCheckpointing が必要）
  setPermissionMode(mode: PermissionMode): Promise<void>; // 権限を変更（ストリーミング入力モードのみ）
  setModel(model?: string): Promise<void>;        // モデルを変更（ストリーミング入力モードのみ）
  setMaxThinkingTokens(max: number | null): Promise<void>; // 思考トークン数を変更（ストリーミング入力モードのみ）
  supportedCommands(): Promise<SlashCommand[]>;   // 利用可能なスラッシュコマンド
  supportedModels(): Promise<ModelInfo[]>;         // 利用可能なモデル
  mcpServerStatus(): Promise<McpServerStatus[]>;  // MCP サーバーの接続状態
  accountInfo(): Promise<AccountInfo>;             // 認証済みユーザー情報
}
```

sdk.d.ts には存在するが、公式ドキュメントにないもの（内部用の可能性あり）：
- `streamInput(stream)` — 追加のユーザーメッセージをストリーミングする
- `close()` — クエリを強制終了する
- `setMcpServers(servers)` — MCP サーバーを動的に追加/削除する

## サンドボックス設定 (Sandbox Configuration)

```typescript
type SandboxSettings = {
  enabled?: boolean;
  autoAllowBashIfSandboxed?: boolean;
  excludedCommands?: string[];
  allowUnsandboxedCommands?: boolean;
  network?: {
    allowLocalBinding?: boolean;
    allowUnixSockets?: string[];
    allowAllUnixSockets?: boolean;
    httpProxyPort?: number;
    socksProxyPort?: number;
  };
  ignoreViolations?: {
    file?: string[];
    network?: string[];
  };
};
```

`allowUnsandboxedCommands` が true の場合、モデルは Bash ツールの入力で `dangerouslyDisableSandbox: true` を設定でき、その場合は `canUseTool` 権限ハンドラーにフォールバックします。

## MCP サーバーヘルパー

### tool()

Zod スキーマを使用して、型安全な MCP ツール定義を作成します：

```typescript
function tool<Schema extends ZodRawShape>(
  name: string,
  description: string,
  inputSchema: Schema,
  handler: (args: z.infer<ZodObject<Schema>>, extra: unknown) => Promise<CallToolResult>
): SdkMcpToolDefinition<Schema>
```

### createSdkMcpServer()

プロセス内 MCP サーバーを作成します（我々はサブエージェントへの継承のために stdio を使用しています）：

```typescript
function createSdkMcpServer(options: {
  name: string;
  version?: string;
  tools?: Array<SdkMcpToolDefinition<any>>;
}): McpSdkServerConfigWithInstance
```

## 内部リファレンス

### 主要な難読化識別子 (sdk.mjs)

| 識別子 | 目的 |
|----------|---------|
| `s_` | V1 `query()` のエクスポート |
| `e_` | `unstable_v2_createSession` |
| `Xx` | `unstable_v2_resumeSession` |
| `Qx` | `unstable_v2_prompt` |
| `U9` | V2 Session クラス (`send`/`stream`/`close`) |
| `XX` | ProcessTransport (`cli.js` を起動) |
| `$X` | Query クラス (JSON-line ルーティング、非同期イテラブル) |
| `QX` | AsyncQueue (入力ストリームバッファ) |

### 主要な難読化識別子 (cli.js)

| 識別子 | 目的 |
|----------|---------|
| `EZ` | コアとなる再帰的エージェントループ（非同期ジェネレーター） |
| `_t4` | 停止フックハンドラー (tool_use ブロックがない場合に実行) |
| `PU1` | ストリーミングツール実行エンジン (API レスポンス中に並列実行) |
| `TP6` | 標準ツール実行エンジン (API レスポンス終了後に実行) |
| `GU1` | 個別ツール実行エンジン |
| `lTq` | SDK セッションランナー (`EZ` を直接呼び出す) |
| `bd1` | stdin リーダー (トランスポートからの JSON-lines) |
| `mW1` | Anthropic API ストリーミング呼び出し関数 |

## 主要ファイル

- `sdk.d.ts` — すべての型定義 (1777 行)
- `sdk-tools.d.ts` — ツールの入力スキーマ
- `sdk.mjs` — SDK ランタイム (難読化済み, 376KB)
- `cli.js` — CLI 実行ファイル (難読化済み, サブプロセスとして実行)
