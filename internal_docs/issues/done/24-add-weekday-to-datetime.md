# エージェントの日時情報に曜日を追加

## 概要

エージェントが把握できる現在の日時情報に曜日（Sun, Mon 等）を追加する。チャット、cron タスク、heartbeat の全経路で統一的に曜日付き日時を提供する。

## 現状の実装

チャット経路では `src/router.ts:29` で `<context timezone="..." />` タグにタイムゾーンのみ渡しており、現在時刻は含まれていなかった:

```ts
const header = `<context timezone="${escapeXml(timezone)}" />\n`;
```

cron/heartbeat 経路では `container/agent-runner/src/index.ts:810-812` でプロンプトを構築するが、日時情報は付与されていなかった:

```ts
let prompt = containerInput.prompt;
if (containerInput.isScheduledTask) {
  prompt = `[SCHEDULED TASK - ...]\n\n${prompt}`;
}
```

## 実装方針

### 1. `src/timezone.ts` に `formatCurrentTime` 関数を追加

`weekday: 'short'` を含む `toLocaleString` で `"Sun, Apr 6, 2025, 3:45 PM"` 形式の文字列を返す。

### 2. `src/router.ts` の context タグに `current_time` 属性を追加

```ts
const header = `<context timezone="..." current_time="Sun, Apr 6, 2025, 3:45 PM" />\n`;
```

### 3. `container/agent-runner/src/index.ts` のスケジュールタスクプロンプトに日時を挿入

`toLocaleString` で同形式の曜日付き日時を生成し、`[SCHEDULED TASK]` ヘッダーに `Current time:` 行として追加。コンテナの `TZ` 環境変数が設定済みのため、ホストと一致する。

## エッジケース

- タイムゾーンが無効な場合: `resolveTimezone` で UTC にフォールバック（既存動作）
- コンテナに `TZ` 環境変数が渡されない場合: `toLocaleString` はシステムデフォルトを使用

## 関連ファイル

- `src/timezone.ts` — `formatCurrentTime` 関数を追加
- `src/router.ts` — context タグに `current_time` 属性を追加
- `container/agent-runner/src/index.ts` — スケジュールタスクのプロンプトに日時を追加
- `src/timezone.test.ts` — `formatCurrentTime` のテストを追加
- `src/formatting.test.ts` — context タグのアサーションを更新
