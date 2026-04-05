# Override 実装設計

## 概要

`GroupType: 'override'` はサンドボックスを解除した一時的なフル権限スレッド。全ツールコールが Discord にリアルタイムログ出力され、常に監視される前提で動作する。

## ライフサイクル

1. `/override-start` スラッシュコマンドで新しい Discord スレッドを作成
2. スレッドを `type: 'override'` の一時グループとして自動登録
3. override スレッド内でエージェントがフル権限で動作（全ツールコールをログ出力）
4. `/override-end` でスレッドをアーカイブし、グループ登録を削除

## 送信者の制限

Discord のスラッシュコマンドは `default_member_permissions` および Guild Command Permissions でユーザー ID を指定して実行権限を制限できる。

- スラッシュコマンド登録時にオーナーのユーザー ID のみ許可
- Discord 側で権限チェックが完結するため、アプリケーション側の検証は補助的

## サンドボックス解除の粒度（未決定）

NanoClaw のサンドボックスは2層構造:

| 層 | 何をしているか | 解除方法 |
|---|---|---|
| 外側: Docker コンテナ | ファイルシステム・プロセスの物理的隔離 | マウント範囲の拡大 / ホスト直接実行 |
| 内側: Claude Code Sandbox | Bash の seatbelt/landlock | SDK の `sandbox.enabled: false` + `allowUnsandboxedCommands: true` |

### 案A: コンテナ維持 + 内側サンドボックス解除

- コンテナは維持し、マウント範囲を大幅に拡大（例: ホームディレクトリ全体を read-write）
- SDK の `SandboxSettings` で内側のサンドボックスを解除
- credential-proxy による API キー隔離は維持される
- 既存のコンテナ管理インフラをそのまま使える

### 案B: コンテナなし、ホスト直接実行

- `runContainerAgent()` を迂回し、ホスト上で直接 agent-runner を実行
- 最大の自由度（ホストの全リソースにアクセス可能）
- credential-proxy の保護が崩れる（API キーがプロセス環境変数に露出）
- コンテナ前提の IPC・セッション管理を別経路で実装する必要がある

## ツールコールログ

### 仕組み

SDK の `PreToolUse` / `PostToolUse` フックでツールコールをインターセプトし、IPC 経由で Discord に送信。

```
agent-runner (コンテナ内)
  → PreToolUse フック: ツール名・入力を取得
  → PostToolUse フック: 結果を取得
  → IPC ファイルに書き出し (/workspace/ipc/messages/)
      → ホストの IPC watcher が検知 → Discord チャンネルに送信
```

### 考慮事項

- **ログ量**: Read/Grep が大量に発生しうる。要約・フィルタリングが必要
- **Discord 2000文字制限**: 長い出力は truncate または分割
- **IPC ポーリング間隔**: 現在1秒。厳密なリアルタイムではないが十分
- **フックの戻り値**: `PreToolUse` で `{ continue: true }` を返さないとツール実行がブロックされる

### ログフォーマット（案）

```
🔧 Bash: npm install express
📁 Read: src/index.ts (lines 1-50)
✏️ Edit: src/config.ts
```

ログの詳細度（入力全体を出すか、要約だけにするか）は運用しながら調整。

## 一時グループの管理

### 登録

- `/override-start` 実行時に Discord スレッドを作成
- `dc:{threadId}` を JID として `registerGroup()` で登録
- DB に `type: 'override'` として保存（一時フラグも付与）

### 削除

- `/override-end` 実行時にグループ登録を削除
- Discord スレッドをアーカイブ
- セッションデータ (`data/sessions/{name}/`) は保持（後から参照可能）

### 未決定事項

- **自動タイムアウト**: override を開いたまま忘れた場合の対策。30分無操作でアーカイブなど
- **同時複数 override**: 許可するか、1つに制限するか
- **通常メッセージとの競合**: override 中に同じ親チャネルでメッセージが来た場合の挙動

## IPC 認可

override グループはログ送信のために他チャットへのメッセージ送信が必要。

### 選択肢

- **案1**: override に `isMain` 相当の IPC 権限を付与（シンプル）
- **案2**: ログ送信先 JID だけを許可リストに追加（最小権限）

## `isMain` → `type` への移行

override 実装の前提として、既存の `isMain: boolean` を `type: GroupType` に移行する必要がある。

### DB マイグレーション

```sql
ALTER TABLE registered_groups ADD COLUMN group_type TEXT DEFAULT 'chat';
UPDATE registered_groups SET group_type = 'main' WHERE is_main = 1;
UPDATE registered_groups SET group_type = 'chat' WHERE is_main = 0 OR is_main IS NULL;
```

### コード変更箇所

- `types.ts`: `RegisteredGroup.isMain` → `RegisteredGroup.type`
- `db.ts`: カラム名・クエリ変更
- `index.ts`: `group.isMain` チェックを `group.type === 'main' || group.type === 'override'` に
- `ipc.ts`: IPC 認可の判定ロジック
- `container-runner.ts`: マウント・権限の判定ロジック
- `agent-runner`: `ContainerInput.isMain` → `ContainerInput.type`

### 移行タイミング（未決定）

- **案1**: override と同時に移行（一括で整合性を取れる）
- **案2**: 先に type 移行だけ行い、override は後から追加（段階的、リスク分散）

## 実装に必要なもの（まとめ）

1. `isMain` → `type: GroupType` への移行（DB + コード全体）
2. Discord スラッシュコマンド `/override-start`, `/override-end` の登録と権限設定
3. スラッシュコマンドで Discord スレッドを作成し、一時グループとして登録するロジック
4. `container-runner.ts` の override 用マウント・サンドボックス設定
5. `agent-runner` への `PreToolUse` / `PostToolUse` フック追加（ログ送信）
6. IPC watcher でのログメッセージ → Discord 転送
7. `/override-end` でのグループ削除・スレッドアーカイブ処理
