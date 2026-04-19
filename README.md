<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  エージェントを独自のコンテナで安全に実行するAIアシスタント。軽量で、簡単に理解でき、あなたのニーズに完全にカスタマイズ可能。
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="README_zh.md">中文</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="34.9k tokens, 17% of context window" valign="middle"></a>
</p>

---

<h2 align="center">🐳 Docker Sandboxes & 🍎 Apple Container</h2>
<p align="center">すべてのエージェントが独自の隔離コンテナで実行されます。<br>Docker Sandboxesによるハイパーバイザー レベルの隔離、またはApple Containerによるネイティブで軽量なmacOS隔離を選択できます。ミリ秒単位の起動。複雑な設定は不要です。</p>

**macOS (Apple Silicon)**

```bash
curl -fsSL https://nanoclaw.dev/install-docker-sandboxes.sh | bash
```

**Windows (WSL)**

```bash
curl -fsSL https://nanoclaw.dev/install-docker-sandboxes-windows.sh | bash
```

> 現在、macOS (Apple Silicon) と Windows (x86) をサポートしています。Linux対応は近日公開予定です。

<p align="center"><a href="https://nanoclaw.dev/blog/nanoclaw-docker-sandboxes">お知らせを読む →</a>&nbsp; · &nbsp;<a href="docs/docker-sandboxes.md">マニュアル設定ガイド →</a></p>

---

## NanoClawを作った理由

[OpenClaw](https://github.com/openclaw/openclaw) は素晴らしいプロジェクトですが、私が理解できない複雑なソフトウェアに人生への完全なアクセス権を与えていたら、眠れなかったでしょう。OpenClawには約50万行のコード、53個の設定ファイル、70以上の依存関係があります。そのセキュリティはアプリケーションレベル（許可リスト、ペアリングコード）であり、真のOSレベルの隔離ではありません。すべてが共有メモリを持つ1つのNodeプロセスで実行されています。

NanoClawは同じコア機能を提供しますが、理解しやすい規模のコードベースで実現しています：1つのプロセスと少数のファイルだけです。Claudeエージェントは独自のLinuxコンテナでファイルシステム隔離付きで実行され、単なる権限チェックの裏側ではありません。

## このフォークについて

これは**パーソナルなAIエージェント**です。

- **自分が使いやすいと思う機能だけ**を実装しています
- **必要ない機能は追加しません**
- **破壊的変更も頻繁にします**

このリポジトリは個人的な用途に最適化されており、他の人のユースケースを考慮していません。元のNanoClawと異なり、互換性や汎用性を維持する義務はありません。

## クイックスタート

```bash
gh repo fork qwibitai/nanoclaw --clone
cd nanoclaw
claude
```

<details>
<summary>GitHub CLIを使わない場合</summary>

1. GitHubで [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw) をフォーク（Forkボタンをクリック）
2. `git clone https://github.com/<your-username>/nanoclaw.git`
3. `cd nanoclaw`
4. `claude`

</details>

その後 `/setup` を実行してください。Claude Codeがすべてを処理します：依存関係、認証、コンテナ設定、サービス設定。

> **注：** `/` で始まるコマンド（`/setup`、`/add-whatsapp` など）は [Claude Codeスキル](https://code.claude.com/docs/en/skills) です。通常のターミナルではなく、`claude` CLIプロンプト内で入力してください。Claude Codeがインストールされていない場合は、[claude.com/product/claude-code](https://claude.com/product/claude-code) から入手してください。

## 哲学

**理解できる規模。** 1つのプロセス、少数のソースファイル、マイクロサービスなし。NanoClawのコードベース全体を理解したい場合は、Claude Codeに説明を依頼するだけです。

**隔離によるセキュリティ。** エージェントはLinuxコンテナ（macOSではApple Container、またはDocker）で実行され、明示的にマウントされたもののみが見えます。Bashアクセスは安全です。コマンドはホストではなくコンテナ内で実行されるからです。

**個人ユーザー向けに構築。** NanoClawは巨大なフレームワークではなく、各ユーザーの正確なニーズに合わせたソフトウェアです。肥大化するのではなく、NanoClawはオーダーメイドになるように設計されています。独自のフォークを作成し、Claude Codeに変更を加えてニーズに合わせてください。

**カスタマイズ = コード変更。** 設定の肥大化はありません。違う動作が欲しい？コードを変更してください。コードベースは小さく、変更しても安全です。

**AIネイティブ。**

- インストールウィザードはなし。Claude Codeが設定をガイドします。
- モニタリングダッシュボードはなし。Claudeに状況を尋ねてください。
- デバッグツールはなし。問題を説明すればClaudeが修正します。

**機能よりスキル。** Telegram対応などの機能をコードベースに追加するのではなく、貢献者は `/add-telegram` のような [claude codeスキル](https://code.claude.com/docs/en/skills) を提出します。正確に必要なことを行うクリーンなコードが手に入ります。

**最高のハーネス、最高のモデル。** NanoClawはClaude Agent SDK上で実行され、Claude Codeを直接実行しています。Claude Codeは高度に capable であり、そのコーディングと問題解決能力により、NanoClawを変更・拡張し、各ユーザーに合わせて調整できます。

## サポートしている機能

- **マルチチャンネルメッセージング** - WhatsApp、Telegram、Discord、Slack、Gmailからアシスタントと会話できます。`/add-whatsapp` や `/add-telegram` のようなスキルでチャンネルを追加。1つまたは複数を同時に実行できます。
- **隔離されたグループコンテキスト** - 各グループは独自の `CLAUDE.md` メモリ、隔離されたファイルシステムを持ち、そのファイルシステムのみがマウントされたコンテナサンドボックスで実行されます。
- **メインチャンネル** - 管理用のプライベートチャンネル（セルフチャット）。すべてのグループは完全に隔離されています
- **スケジュールされたタスク** - Claudeを実行し、メッセージを返信できる定期ジョブ
- **Webアクセス** - Webからコンテンツを検索・取得
- **コンテナ隔離** - エージェントは [Docker Sandboxes](https://nanoclaw.dev/blog/nanoclaw-docker-sandboxes)（マイクロVM隔離）、Apple Container（macOS）、またはDocker（macOS/Linux）でサンドボックス化されます
- **エージェントスワーム** - 複雑なタスクに協力する専門エージェントのチームを立ち上げる
- **オプションの統合** - Gmail（`/add-gmail`）などをスキル経由で追加

## 使い方

トリガーワード（デフォルト：`@Andy`）でアシスタントと会話します：

```
@Andy 平日の朝9時にセールスパイプラインの概要を送信してください（Obsidian vaultフォルダへのアクセス権あり）
@Andy 毎週金曜日に過去1週間のgit履歴をレビューし、ドリフトがあればREADMEを更新してください
@Andy 毎週月曜日の朝8時に、Hacker NewsとTechCrunchからAI開発に関するニュースをまとめてブリーフィングを送信してください
```

メインチャンネル（セルフチャット）から、グループとタスクを管理できます：

```
@Andy すべてのグループのスケジュールされたタスクを一覧表示
@Andy 月曜日のブリーフィングタスクを一時停止
@Andy Family Chatグループに参加
```

## カスタマイズ

NanoClawは設定ファイルを使用しません。変更を加えるには、Claude Codeに望みを伝えるだけです：

- 「トリガーワードを @Bob に変更して」
- 「今後はレスポンスを短く直接的にしてほしい」
- 「おはようと言ったときにカスタム挨拶を追加して」
- 「会話の要約を毎週保存して」

または `/customize` を実行してガイド付きの変更を行ってください。

コードベースは小さく、Claudeが安全に変更できる規模です。

## 貢献

**機能を追加するのではなく、スキルを追加してください。**

Telegram対応を追加したい場合、コアコードベースにTelegramを追加するPRを作成しないでください。代わりに、NanoClawをフォークし、ブランチでコード変更を行い、PRを開いてください。他のユーザーがフォークにマージできる `skill/telegram` ブランチを作成します。

ユーザーはフォークで `/add-telegram` を実行し、すべてのユースケースをサポートしようとする肥大化したシステムではなく、正確に必要なことを行うクリーンなコードを手に入れます。

### RFS（スキルのリクエスト）

以下のスキルを募集しています：

**コミュニケーションチャンネル**

- `/add-signal` - Signalをチャンネルとして追加

**セッション管理**

- `/clear` - 会話をコンパクト化する `/clear` コマンドを追加（同じセッション内で重要な情報を保持しながらコンテキストを要約）。Claude Agent SDK経由でプログラム的にコンパクションをトリガーする方法を解決する必要があります。

## 要件

- macOS または Linux
- Node.js 20+
- [Claude Code](https://claude.ai/download)
- [Apple Container](https://github.com/apple/container)（macOS）または [Docker](https://docker.com/products/docker-desktop)（macOS/Linux）

## アーキテクチャ

```
Channels --> SQLite --> Polling loop --> Container (Claude Agent SDK) --> Response
```

単一のNode.jsプロセス。チャンネルはスキル経由で追加され、起動時に自己登録します — オーケストレーターは認証情報が存在するものを接続します。エージェントはファイルシステム隔離付きの隔離されたLinuxコンテナで実行されます。マウントされたディレクトリのみがアクセス可能です。ファイルシステム経由のIPC。並行性制御付きのグループごとのメッセージキュー。

詳細なアーキテクチャについては、[docs/SPEC.md](docs/SPEC.md) を参照してください。

主要ファイル：

- `src/index.ts` - オーケストレーター：状態、メッセージループ、エージェント呼び出し
- `src/channels/registry.ts` - チャンネルレジストリ（起動時の自己登録）
- `src/ipc.ts` - IPCウォッチャーとタスク処理
- `src/router.ts` - メッセージフォーマットとアウトバウンドルーティング
- `src/group-queue.ts` - グローバル並行性制限付きのグループごとキュー
- `src/container-runner.ts` - ストリーミングエージェントコンテナの生成
- `src/task-scheduler.ts` - スケジュールされたタスクの実行
- `src/db.ts` - SQLite操作（メッセージ、グループ、セッション、状態）
- `groups/*/CLAUDE.md` - グループごとのメモリ

## FAQ

**なぜDocker？**

Dockerはクロスプラットフォーム対応（macOS、Linux、さらにはWSL2経由のWindows）と成熟したエコシステムを提供します。macOSでは、より軽量なネイティブランタイムのために `/convert-to-apple-container` 経由でオプションでApple Containerに切り替えることができます。

**Linuxで実行できますか？**

はい。Dockerはデフォルトのランタイムで、macOSとLinuxの両方で動作します。`/setup` を実行するだけです。

**これは安全ですか？**

エージェントはアプリケーションレベルの権限チェックの後ろではなく、コンテナ内で実行されます。明示的にマウントされたディレクトリのみにアクセスできます。実行内容はレビューすべきですが、コードベースは小さく、実際にレビューできます。完全なセキュリティモデルについては [docs/SECURITY.md](docs/SECURITY.md) を参照してください。

**なぜ設定ファイルがないの？**

設定の肥大化は避けたいからです。すべてのユーザーは、ジェネリックなシステムを設定するのではなく、コードが正確に望むことを行うようにNanoClawをカスタマイズすべきです。設定ファイルを使いたい場合は、Claudeに追加するように依頼できます。

**サードパーティまたはオープンソースのモデルを使えますか？**

はい。NanoClawはClaude API互換のモデルエンドポイントをサポートしています。`.env` ファイルに以下の環境変数を設定してください：

```bash
ANTHROPIC_BASE_URL=https://your-api-endpoint.com
ANTHROPIC_AUTH_TOKEN=your-token-here
```

これにより以下が使用できます：

- APIプロキシ経由の [Ollama](https://ollama.ai) のローカルモデル
- [Together AI](https://together.ai)、[Fireworks](https://fireworks.ai) などでホストされるオープンソースモデル
- Anthropic互換APIを持つカスタムモデルデプロイメント

注：モデルはAnthropic API形式をサポートしている必要があります。

**問題をデバッグするには？**

Claude Codeに尋ねてください。「スケジューラーが実行されていないのはなぜ？」「最近のログには何がある？」「なぜこのメッセージに応答がない？」これがNanoClawの基盤となるAIネイティブなアプローチです。

**セットアップがうまくいきません**

問題がある場合、セットアップ中にClaudeが動的に修正しようとします。それでも機能しない場合は、`claude` を実行してから `/debug` を実行してください。Claudeが他のユーザーも影響を受けている可能性のある問題を見つけた場合は、セットアップSKILL.mdを修正するPRを開いてください。

**コードベースにどのような変更が受け入れられますか？**

セキュリティ修正、バグ修正、明確な改善のみがベース設定に受け入れられます。以上です。

その他すべて（新機能、OS互換性、ハードウェアサポート、機能強化）はスキルとして貢献すべきです。

これによりベースシステムは最小限に保たれ、すべてのユーザーが不要な機能を継承することなく、インストールをカスタマイズできます。

## コミュニティ

質問？アイデア？[Discordに参加](https://discord.gg/VDdww8qS42)。

## 変更履歴

重大な変更と移行ノートについては [CHANGELOG.md](CHANGELOG.md) を参照してください。

## ライセンス

MIT
