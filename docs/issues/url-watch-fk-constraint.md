# Bug: url_watch でスレッド作成後に FOREIGN KEY 制約違反でエージェントが起動しない

## 症状

`channel_mode: url_watch` のチャンネルに URL を投稿すると、Discord スレッドは作成されるが
エージェントが応答しない。ログに以下のエラーが繰り返し出力される。

```
ERROR: URL thread spawn failed
  chatJid: "dc:1492896491704942774"
  err: {
    "type": "SqliteError",
    "message": "FOREIGN KEY constraint failed",
    "code": "SQLITE_CONSTRAINT_FOREIGNKEY"
    "stack":
        SqliteError: FOREIGN KEY constraint failed
            at storeMessage (dist/db.js:459:167)
            at spawnThreadForUrl (dist/index.js:164:5)
  }
```

## 原因

### DB スキーマ上の制約

`messages` テーブルは `chats` テーブルへの外部キーを持つ。

```sql
-- src/db.ts:219
FOREIGN KEY (chat_jid) REFERENCES chats(jid)
```

### `spawnThreadForUrl` の処理フロー

`src/index.ts` の `spawnThreadForUrl` 関数（L196〜L276）では：

1. `channel.createThread(chatJid, threadName, msg.id)` → Discord スレッドを作成し `threadJid` を取得
2. `registerGroup(threadJid, childGroup)` → `registered_groups` テーブルに登録
3. **`storeMessage(syntheticMsg)` ← ここで FK 違反が発生**
4. `queue.enqueueTask(...)` → エージェント起動（3 で例外が throw されるため到達しない）

### 欠けているステップ

`storeChatMetadata` は Discord チャンネルの `onMessage` ハンドラ内で受信メッセージごとに呼ばれる
（`src/channels/discord.ts:170`）。プログラム的に作成したスレッドには Discord からのメッセージ
受信イベントが発生しないため、`chats` テーブルに `threadJid` のエントリが存在しない状態で
`storeMessage` が呼ばれ、FK 制約に違反する。

## 再現条件

- `channel_mode: url_watch` で登録済みの Discord チャンネルに URL を含むメッセージを投稿する
- Discord チャンネルが `createThread` を実装している（Discord チャンネルは実装済み）

## 修正方針

`spawnThreadForUrl` 内の `storeMessage(syntheticMsg)` の**直前**に `storeChatMetadata` を呼び出し、
`chats` テーブルにエントリを作成する。

```typescript
// src/index.ts - spawnThreadForUrl 内

// ★ 追加: chats テーブルに threadJid を事前登録（storeMessage の FK 制約を満たすため）
storeChatMetadata(
  threadJid,
  msg.timestamp,
  threadName,
  channel.name,
  true,
);

const childGroup: RegisteredGroup = {
  ...
  channel_mode: 'url_watch',  // ★ 追加: url_watch スレッドとして識別するため
};
registerGroup(threadJid, childGroup);
if (!registeredGroups[threadJid]) {
  throw new Error('Thread group registration was rejected');
}

const syntheticMsg: InboundMessage = { ... };
storeMessage(syntheticMsg);  // これで FK 違反が起きなくなる

// 全初期化が成功した後に予約を確定する
finalizeSpawnedThread(msg.id, threadJid);
```

`storeChatMetadata` は `src/index.ts` の L45 で既にインポート済み。

## 関連コード

| ファイル | 行 | 内容 |
|---|---|---|
| `src/index.ts` | L196–276 | `spawnThreadForUrl` 全体 |
| `src/index.ts` | L231, L256 | `finalizeSpawnedThread` → `storeMessage` の順序 |
| `src/db.ts` | L217–219 | `messages` テーブルの FK 定義 |
| `src/db.ts` | L495–540 | `storeChatMetadata` の実装 |
| `src/channels/discord.ts` | L168–176 | 受信メッセージで `onChatMetadata` を呼ぶ箇所 |

## 補足

直近のコミット `b9684f6 Fix url_watch initial thread processing` および
`1855667 feat: update spawnThreadForUrl to mention assistant and mark message as sent by me`
で url_watch の初回処理が改修されたが、本 FK 制約問題は残存している。

同一エラーが複数セッションにわたって継続して発生しており（ログ上で少なくとも 5 回確認）、
url_watch は現状ほぼ機能していない状態。
