# Thread 実装計画

この文書は、NanoClaw における `thread` を実装するための作業計画書である。`docs/thread-based-architecture/` 配下の設計意図に沿い、`thread` を VRC-AI-Bot の PlaceType の移植ではなく、**親 group から派生する作業単位** として実装する。

## 目的

- Discord thread を NanoClaw の `thread` group として扱えるようにする
- `chat` と `thread` の違いを、別 JID と別 Claude session で表現する
- 将来的に通常 group 用設定と thread 用共有設定を分けられるよう、拡張しやすい形にする

## 非目的

- VRC-AI-Bot の `PlaceType` / `Scope` / `ChatBehavior` を全面移植すること
- `thread` 用に別 `folder` を自動生成すること
- `thread` 用に `chat` と別の独立パーミッション階層を作ること
- Discord 上のすべての thread を自動的に NanoClaw の `thread` と見なすこと

## 到達状態

実装後の `thread` は次の性質を持つ。

- 親 group と別の `chat_jid` を持つ
- 親 group と別の Claude session を持つ
- 親 group の `thread_defaults` があるときだけ、自動登録される
- `type: 'thread'` として DB に保存される
- 権限レベルは `chat` と同じ非特権側で開始する
- 将来の thread 用共有設定を継承できる構造を持つ

## 現状整理

現状のコードでは `GroupType` に `thread` は存在するが、挙動の大半は `chat` と同じである。

- `thread` は有効な `GroupType` として解決される
- `chat` / `thread` はどちらも非特権扱いで、デフォルト allowed tools は `["Read"]`
- Discord adapter は thread を正しく判定していない
- `place_type` は常に `guild_text`
- `is_thread` は常に `false`
- `thread_defaults` の型、保存、継承、自動登録は未実装

## 実装方針

実装は 3 フェーズで進める。

### Phase 1: Discord adapter で thread を正しく認識する

目的:
- Discord の message が thread 上かどうかを正しく識別する
- `chat_jid` が親 channel ではなく thread id を指す状態を前提に、メタデータを正しく流す

変更内容:
- `src/channels/discord.ts`
  - `message.channel.isThread()` を使って thread 判定する
  - `place_type` を channel type に応じて埋める
    - public thread
    - private thread
    - forum post thread
    - それ以外は guild text
  - `is_thread` を正しく設定する
  - `chatName` は親 channel と thread 名を含む形にする

完了条件:
- thread 上の message を受けたとき、`chat_jid` が `dc:{threadId}` になる
- `InboundMessage.is_thread === true` になる
- ログと chat metadata 上で thread が識別できる

### Phase 2: `thread_defaults` と自動登録を入れる

目的:
- 親 group に `thread_defaults` があるとき、その thread を派生 group として自動登録する

データモデル:
- `RegisteredGroup` に `thread_defaults` を追加する
- `thread_defaults` は少なくとも以下を持てるようにする
  - `type`
  - `requiresTrigger`
  - `containerConfig`
  - 将来の thread 用共有設定

保存:
- DB に `thread_defaults` 用 JSON カラムを追加する
- `register_group` / `update_group` IPC で保存できるようにする

自動登録ルール:
- thread message を受信したが、その `chat_jid` に対応する登録 group がない場合のみ発火
- 親 channel の `chat_jid` を導出し、親 group を探す
- 親 group に `thread_defaults` がなければ何もしない
- 親 group に `thread_defaults` があれば、その内容を使って子 group を登録する
- 子 group の `type` は `thread`
- 子 group の `jid` は `dc:{threadId}`
- 子 group の `folder` は親 group と同じ値を使う
  - `thread` は別 folder を持たない
  - 分離は JID と session で行う

命名:
- 子 group の `name` は `msg.sender_name` から導出した値を使う
  - 例: `Thread (from Alice)`
- `added_at` は自動登録時刻

完了条件:
- 親 group に `thread_defaults` がある状態で thread message を送ると、自動で子 group が登録される
- 親 group に `thread_defaults` がない場合は登録されない

### Phase 3: Claude session を group 単位で分離する

目的:
- `thread` が親 group と別の会話履歴を持つようにする

現状:
- session は `group.folder` 単位で保存されている
- このままだと親と thread が同じ folder を共有した場合、同じ session に流れ込む

変更内容:
- session のキーを `group.folder` から **group を一意に識別できるキー** に変更する
- このキーは `jid` ベースにするのが最も単純

変更対象:
- sessions テーブル
- `getAllSessions()`
- `setSession()`
- `src/index.ts`
- `src/task-scheduler.ts`
- `src/container-runner.ts` に渡す session lookup

要件:
- `chat` と `thread` が同じ folder を共有していても、Claude session は混ざらない
- session の分離単位は **group** である
- 将来、thread 用共有設定を変える前提と整合する

マイグレーション方針:
- 既存の `group_folder` ベース session をそのまま上書き移行しない
- 新しいキー列を導入するか、sessions テーブルを group id ベースに置き換える
- 旧 session は必要なら読み取り時にフォールバックしてもよいが、書き込みは新キーに統一する

完了条件:
- 親 group と thread group が別 session を持つ
- 片方の会話履歴がもう片方に流れない

## サーバー側のメッセージ処理

### 現状の処理フロー

`index.ts` のメッセージ処理は次の 2 層で動く。

```
onMessage callback (channel → index.ts)
  └── storeMessage(msg)   ← 登録済みかどうかに関わらず DB に保存

startMessageLoop (POLL_INTERVAL ごと)
  └── getNewMessages(registered jids only)
        └── registeredGroups[chatJid] が undefined → continue (スキップ)
              └── トリガー判定 → queue.enqueueMessageCheck or sendMessage
                    └── processGroupMessages → runAgent
```

重要な点として、`onMessage` は `registeredGroups[chatJid]` を参照していない。
メッセージは thread であっても DB に保存される。スキップされるのは `startMessageLoop` 側。

### thread 自動登録の差し込み点

`startMessageLoop` 内の以下の箇所が自然な差し込み点になる。

```ts
// 現状
const group = registeredGroups[chatJid];
if (!group) continue;

// 拡張後
const group = registeredGroups[chatJid];
if (!group) {
  // thread 自動登録を試みる
  const registered = await tryAutoRegisterThread(chatJid, msg);
  if (!registered) continue;
  // 登録完了 → 次のポーリングサイクルで処理（同サイクルでは処理しない）
  continue;
}
```

自動登録後は **同サイクルで処理しない**。`registeredGroups` への反映と `lastAgentTimestamp` の初期化が揃ってから、次のポーリングで通常フローに乗せるのが安全。

`tryAutoRegisterThread` の内部ロジック:

1. `chatJid` から親チャンネルの JID を導出する（Discord の場合 `dc:{parentChannelId}`）
2. `registeredGroups` から親 group を探す
3. 親に `thread_defaults` がなければ `return false`
4. `thread_defaults` の内容で子 group を組み立てて `registerGroup(chatJid, childGroup)` を呼ぶ

### トリガー判定

thread group の `requiresTrigger` は `thread_defaults` から継承する。親が `requiresTrigger: false` の group なら、thread も同様に全メッセージで起動する。自動登録時に子 group の `requiresTrigger` に明示的にセットしておく。

### session キーの問題

現状、session は `group.folder` をキーに保存している（`runAgent` 内）。

```ts
const sessionId = sessions[group.folder];   // index.ts:277
sessions[group.folder] = output.newSessionId; // index.ts:304
```

親 group と thread group が同じ `folder` を共有する設計のため、このままだと Claude session が混ざる。Phase 3 で session キーを `chatJid`（group の jid）に変更することでこれを解消する。

変更が必要な箇所:

- `sessions` の型を `Record<string, string>` のまま維持しつつ、キーを `folder` → `jid` に変更
- `getAllSessions()` / `setSession()` の DB スキーマも同様
- `task-scheduler.ts` も同じキーで session を参照しているため追従が必要

マイグレーション方針は `group-type-spec.md` の方針（新キー列を追加、書き込みを新キーに統一）に従う。

## 将来拡張

### thread 用共有設定

`thread` の価値は独立パーミッションではなく、**会話分離と thread 群に対する設定差し替え可能性** にある。

そのため、将来は `agent` という名前に限定せず、通常 group 用設定と thread 用共有設定を持てるようにする。

最低限入れたいもの:
- `allowedTools`
- `mcpServers`
- `skills`
- 継承フラグ

適用順序:
- group type のデフォルト
- 通常 group 用設定
- `thread_defaults` から継承された thread 用共有設定

### cleanup / archive

初期実装では必須ではない。必要になったら以下を追加する。

- Discord thread archive と group 状態の同期
- 一定期間非アクティブな thread group の cleanup
- override thread と通常 thread の終了処理の違い

## 変更対象一覧

- `src/types.ts`
  - `RegisteredGroup` に `thread_defaults` を追加
  - 将来の thread 用共有設定型の追加余地を作る
- `src/db.ts`
  - `thread_defaults` の保存・読込
  - sessions の識別子変更
- `src/ipc.ts`
  - `register_group` / `update_group` に `thread_defaults` を追加
- `src/channels/discord.ts`
  - thread 判定
  - parent channel 解決
  - auto registration 起点
- `src/index.ts`
  - group lookup と session lookup のキー変更に追従
- `src/task-scheduler.ts`
  - session lookup のキー変更に追従
- `src/container-runner.ts`
  - 将来の thread 用共有設定注入点を整理

## テスト計画

### 単体テスト

- `thread` message で `is_thread` が `true` になる
- `place_type` が thread 種別に応じて正しく入る
- 親 group に `thread_defaults` があるときだけ子 group が登録される
- 自動登録された子 group が `type: 'thread'` になる
- 親と子が同じ folder を共有しても session が分離される

### 回帰テスト

- 既存の `chat` group の挙動が変わらない
- `main` / `override` の権限判定が変わらない
- scheduler が group session を正しく引ける
- IPC 認可が `chat` / `thread` を非特権として扱い続ける

## 実装順序

1. Discord thread 判定を入れる
2. `thread_defaults` の型・DB・IPC を入れる
3. 自動登録を入れる
4. session 識別子を group 単位に変更する
5. テストを追加する
6. 将来の thread 用共有設定の拡張ポイントを整える

## 判断基準

実装中に迷ったら、次の原則を優先する。

- PlaceType を増やして解決しない
- `thread` の本質は別 folder ではなく別 session
- 差分は権限よりライフサイクルに置く
- 将来の設定差し替えは thread ごとではなく thread 群で共有する
- 親 group が明示的に opt-in した thread だけを NanoClaw の `thread` と見なす
