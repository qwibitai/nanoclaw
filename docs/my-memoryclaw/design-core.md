# 新プロジェクト 要件定義・設計方針

> NanoClawのコードリーディングから得た知見をベースに設計する。
> まだ要件定義フェーズ。名前未定。

---

## 前提

- **チャンネル**: Discordのみ（プライベートサーバー、身内のみ）
- **ホスト環境**: クロスプラットフォーム想定
- **コンテナ**: あり（`--privileged`は付けない。コンテナ内でBash・ネットワークアクセスは全許可だが、ホストへの特権昇格は不可）
- **データベース**: SQL
- **WebUI**: なし（設定変更はエージェントに頼むか手動）

---

## チャンネル・グループ設計

### グループ登録フロー
✅ **実装完了** — SQLiteの `registered_groups` テーブルで管理。

- `src/db.ts` の `setRegisteredGroup()` が登録処理を担当
- Discord チャンネルからの登録は `src/channels/discord.ts` で実装
- 参考: `src/db.ts` L670 (登録フロー)

### トリガー

全メッセージに反応（トリガーワード不要）。

### isMainフラグ
✅ **実装済み** — ただし設計を修正することを推奨

現在の実装：
- `RegisteredGroup` に `requires_trigger?: boolean` フラグ（デフォルト: `true`）
- `requires_trigger: false` 時がメイングループと同義

今後：
- 明示的な `isMain?: boolean` フラグを追加予定（より読みやすく）
- これは後方互換性を保ちながら段階的に導入可能

---

## ストレージ設計

✅ **実装完了** — SQLiteで統一管理。

テーブル構成：
- `chats` — チャット情報（JID、名前、最終メッセージ時刻）
- `messages` — メッセージ本体（ID、内容、タイムスタンプ）
- `sessions` — グループごとのセッション状態
- `scheduled_tasks` — スケジュール付きタスク
- `task_run_logs` — タスク実行ログ
- `registered_groups` — 登録済みグループ情報

参考: `src/db.ts` L1-80 (スキーマ定義)

### タスク管理
✅ **実装完了** — SQLiteで一元管理。

- `scheduled_tasks` テーブルで定期実行を管理
- `task_run_logs` で実行履歴を追跡
- `context_mode`（isolated / shared）に対応

---

## Discordスラッシュコマンド

| コマンド | 動作 | 状態 |
|---|---|---|
| `/new` | セッションリセット — 古い履歴を破棄、新規開始 | 🔄 実装予定 |
| `/model` | プロバイダー切り替え | 🔄 実装予定 |
| `/compact` | 会話履歴を圧縮し、コンテキスト効率を改善 | ✅ 実装済み（[add-compact skill](/.claude/skills/add-compact/SKILL.md)） |

注記：
- `/compact` は NanoClaw が実装したカスタムコマンド（`src/session-commands.ts`）
- API 呼び出し時に SDK の圧縮メカニズムを使用
- 新しい `session_id` が返される（トランザクション保持）

---

## セッション引き継ぎ設計
✅ **実装完了** — SQLiteで管理。

- `src/db.ts` の `setSession(groupFolder, sessionId)` で実装（L523）
- グループごとの固有セッション ID を保存
- Agent SDK の `/compact` でも `newSessionId` が返され、自動更新

参考: `src/db.ts` L523-530 (実装)

---

## `/compact` 設計

✅ **実装済み** — NanoClaw カスタムコマンド。

実装の詳細：
- `src/session-commands.ts` が `/compact` をパース・認可
- メッセージが直接処理されず、`container/agent-runner` に転送
- SDK の圧縮メカニズムを活用（詳細はクローズドソース）
- 会話は `conversations/` に Markdown でアーカイブ（PreCompactHook）

### フロー

```
ユーザーが /compact を送信
  ↓
ホストプロセス (src/session-commands.ts):
  1. コマンドをパース
  2. 認可チェック（メイングループまたは admin）
  3. 他の pending メッセージを先に処理
  ↓
agent-runner (container/agent-runner/src/index.ts):
  1. Pre-compact 時に会話全体を conversations/ に保存
  2. SDK query() 内部で圧縮実行（詳細は non-public）
  3. 新しい session_id を受け取る
  ↓
ホストプロセス:
  setSession(groupFolder, newSessionId) で DB を更新
```

参考: [add-compact skill](/.claude/skills/add-compact/SKILL.md) — 統合手順と詳細

---

## 未決定事項

- [ ] プロジェクト名