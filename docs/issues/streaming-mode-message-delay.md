# Streaming Mode でのメッセージ処理遅延

## 概要

コンテナが streaming mode で動作中、新しいメッセージが IPC 経由でパイプされるが、エージェントの処理が遅い場合に長時間の応答遅延が発生する。

## 発生日時

2026-04-14 08:40〜09:10

## 症状

- 08:40 頃にメッセージを送信
- 約30分後（09:10頃）に応答が届いた
- ユーザー体感では「応答なし」状態が続いた

## ログ分析

```
08:40:32 - Agent output (前のメッセージへの応答完了)
08:40:45 - Discord message stored → New messages (Processing なし)
08:42:46 - Discord message stored → New messages (Processing なし)
           ↓ (約9分間、エージェント内部で処理中)
08:49:26 - Container completed (streaming mode)
08:49:43 - Agent output (蓄積メッセージへの応答)

09:08:05 - Container completed (streaming mode)
09:10:34 - Container completed → Processing messages
09:11:05 - Agent output
```

## 原因

### 1. IDLE_TIMEOUT = 30分

```typescript
// src/config.ts:56
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10);
```

コンテナは最後の出力から30分間生存し続ける。この間、新しいメッセージは IPC 経由で既存コンテナにパイプされる。

### 2. notifyIdle が pendingMessages を無視

```typescript
// src/group-queue.ts:145-151
notifyIdle(groupJid: string): void {
  const state = this.getGroup(groupJid);
  state.idleWaiting = true;
  if (state.pendingTasks.length > 0) {  // pendingMessages はチェックしない
    this.closeStdin(groupJid);
  }
}
```

`notifyIdle` は `pendingTasks` がある場合のみ stdin を閉じる。`pendingMessages` がある場合は閉じないため、メッセージは IPC 経由でパイプされ続ける。

### 3. IPC パイプされたメッセージの処理遅延

メッセージが IPC 経由でコンテナに送られると、エージェント内部で処理される。エージェントが：
- URL フェッチ
- 複雑なツール実行
- 大きなコンテキストウィンドウでの推論

などを行っている場合、応答が遅れる。

## 影響

- ユーザーがメッセージを送っても長時間応答がない
- メッセージが「消えた」ように見える（実際は処理中）
- 複数メッセージが蓄積され、まとめて処理される

## 解決策の選択肢

### A. IDLE_TIMEOUT を短縮

```bash
export IDLE_TIMEOUT=300000  # 5分
```

**メリット**: シンプル、即座に適用可能
**デメリット**: 会話の継続性が損なわれる可能性

### B. notifyIdle で pendingMessages もチェック

```typescript
notifyIdle(groupJid: string): void {
  const state = this.getGroup(groupJid);
  state.idleWaiting = true;
  if (state.pendingTasks.length > 0 || state.pendingMessages) {
    this.closeStdin(groupJid);
  }
}
```

**メリット**: 新しいメッセージがあれば即座に新コンテナで処理
**デメリット**: 会話コンテキストが分断される

### C. 応答タイムアウト機構の追加

IPC 経由でメッセージを送った後、一定時間（例: 3分）応答がなければ stdin を閉じる。

```typescript
// 新しいタイマー: IPC メッセージ送信後の応答待ちタイムアウト
const IPC_RESPONSE_TIMEOUT = 180000; // 3分
```

**メリット**: 通常の会話は継続性を保ちつつ、スタック時にリカバリ
**デメリット**: 実装が複雑

### D. ユーザー通知機構

処理中であることをユーザーに通知（typing indicator の継続、または「処理中です」メッセージ）

**メリット**: ユーザー体験の改善
**デメリット**: 根本解決ではない

## 推奨

短期: **A** (IDLE_TIMEOUT を 5〜10分に短縮)
中期: **C** (IPC 応答タイムアウト機構の追加)

## 関連

- `fix/url-watch-discord` ブランチでの作業
- URL watch スレッドのコンテナが並行して動作している可能性
