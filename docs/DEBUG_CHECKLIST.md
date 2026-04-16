# NanoClaw デバッグ・チェックリスト

## 既知の問題

### 1. [修正済み] セッションツリーの古い位置から再開される問題
エージェントチームがサブエージェントの CLI プロセスを起動すると、それらは同じセッション JSONL に書き込みます。その後の `query()` による再開時、CLI は JSONL を読み込みますが、（サブエージェントのアクティビティより前の）古いブランチの先端を選択してしまうことがあり、エージェントの応答がホスト側で `result` を受信できないブランチに記録されることがありました。**修正方法**: `resumeSessionAt` に最後のアシスタントメッセージの UUID を渡し、再開位置を明示的に固定するようにしました。

### 2. [修正済み] IDLE_TIMEOUT == CONTAINER_TIMEOUT (共に 30分)
両方のタイマーが同時に作動するため、コンテナが `_close` センチネルによる正常な終了ではなく、常にハードな SIGKILL (終了コード 137) で終了してしまう問題がありました。**修正内容**: `IDLE_TIMEOUT` のデフォルト値を 5分（300,000ms）に変更しました。`CONTAINER_TIMEOUT` は引き続き 30分（1,800,000ms）のままで、ハングしたエージェントのためのセーフティネットとして機能しています（`src/config.ts` 参照）。

### 3. [修正済み] エージェントの成功前にカーソルが進んでしまう問題
`processGroupMessages` は、エージェントが実行される前に `lastAgentTimestamp` を進めます。コンテナがタイムアウトした場合、リトライしてもメッセージが見つかりません（カーソルがすでにそれらを通過しているため）。**修正内容**: カーソル進行前に `previousCursor` を保存するようにし、エージェントエラー時にロールバックするよう実装しました。ただし、エラー発生前にユーザーへの出力送信が完了していた場合は重複送信防止のためロールバックをスキップします（`src/index.ts` 参照）。

## クイック・ステータスチェック

```bash
# 1. サービスは実行中か？
launchctl list | grep nanoclaw
# 期待される結果: PID  0  com.nanoclaw (PID = 実行中, "-" = 未実行, 0以外の終了コード = クラッシュ)

# 2. 実行中のコンテナはあるか？
container ls --format '{{.Names}} {{.Status}}' 2>/dev/null | grep nanoclaw

# 3. 停止または孤立したコンテナはあるか？
container ls -a --format '{{.Names}} {{.Status}}' 2>/dev/null | grep nanoclaw

# 4. サービスログに最近のエラーはあるか？
grep -E 'ERROR|WARN' logs/nanoclaw.log | tail -20

# 5. WhatsApp は接続されているか？ (直近の接続イベントを確認)
grep -E 'Connected to WhatsApp|Connection closed|connection.*close' logs/nanoclaw.log | tail -5

# 6. グループはロードされているか？
grep 'groupCount' logs/nanoclaw.log | tail -3
```

## セッション履歴の分岐確認

```bash
# セッションデバッグログで並行する CLI プロセスを確認
ls -la data/sessions/<group>/.claude/debug/

# メッセージを処理したユニークな SDK プロセスをカウント
# 各 .txt ファイル = 1つの CLI サブプロセス。複数ある場合はクエリが並行して走っています。

# 履歴内の parentUuid の分岐を確認
python3 -c "
import json, sys
lines = open('data/sessions/<group>/.claude/projects/-workspace-group/<session>.jsonl').read().strip().split('\n')
for i, line in enumerate(lines):
  try:
    d = json.loads(line)
    if d.get('type') == 'user' and d.get('message'):
      parent = d.get('parentUuid', 'ROOT')[:8]
      content = str(d['message'].get('content', ''))[:60]
      print(f'L{i+1} parent={parent} {content}')
  except: pass
"
```

## コンテナ・タイムアウトの調査

```bash
# 最近のタイムアウトを確認
grep -E 'Container timeout|timed out' logs/nanoclaw.log | tail -10

# タイムアウトしたコンテナのログファイルを確認
ls -lt groups/*/logs/container-*.log | head -10

# 最新のコンテナログを読み込む (パスを置き換えてください)
cat groups/<group>/logs/container-<timestamp>.log

# リトライがスケジュールされたか、何が起きたかを確認
grep -E 'Scheduling retry|retry|Max retries' logs/nanoclaw.log | tail -10
```

## エージェントが応答しない場合

```bash
# WhatsApp からメッセージを受信しているか確認
grep 'New messages' logs/nanoclaw.log | tail -10

# メッセージが処理されているか（コンテナが起動したか）確認
grep -E 'Processing messages|Spawning container' logs/nanoclaw.log | tail -10

# アクティブなコンテナにメッセージがパイプされているか確認
grep -E 'Piped messages|sendMessage' logs/nanoclaw.log | tail -10

# キューの状態を確認 — アクティブなコンテナはあるか？
grep -E 'Starting container|Container active|concurrency limit' logs/nanoclaw.log | tail -10

# lastAgentTimestamp と最新メッセージのタイムスタンプを比較
sqlite3 store/messages.db \"SELECT chat_jid, MAX(timestamp) as latest FROM messages GROUP BY chat_jid ORDER BY latest DESC LIMIT 5;\"
```

## コンテナ・マウントの問題

```bash
# マウント検証ログを確認 (コンテナ起動時に表示)
grep -E 'Mount validated|Mount.*REJECTED|mount' logs/nanoclaw.log | tail -10

# マウント許可リストが読み取り可能か確認
cat ~/.config/nanoclaw/mount-allowlist.json

# DB 内のグループの container_config を確認
sqlite3 store/messages.db \"SELECT name, container_config FROM registered_groups;\"

# コンテナをテスト実行してマウントを確認 (ドライラン)
# <group-folder> をグループのフォルダ名に置き換えてください
container run -i --rm --entrypoint ls nanoclaw-agent:latest /workspace/extra/
```

## WhatsApp 認証の問題

```bash
# QR コードが要求されたか確認 (認証切れを意味します)
grep 'QR\|authentication required\|qr' logs/nanoclaw.log | tail -5

# 認証ファイルが存在するか確認
ls -la store/auth/

# 必要に応じて再認証を行う
npm run auth
```

## サービス管理

```bash
# サービスを再起動
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# ライブログを表示
tail -f logs/nanoclaw.log

# サービスを停止 (注意 — 実行中のコンテナは切り離されますが、終了はされません)
launchctl bootout gui/$(id -u)/com.nanoclaw

# サービスを開始
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nanoclaw.plist

# コード変更後に再ビルドして再起動
npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```
