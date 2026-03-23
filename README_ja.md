<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  エージェントを専用コンテナで安全に実行するAIアシスタント。軽量で、理解しやすく、あなたのニーズに完全にカスタマイズできるように設計されています。
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="README.md">English</a>&nbsp; • &nbsp;
  <a href="README_zh.md">中文</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="34.9k tokens, 17% of context window" valign="middle"></a>
</p>

---

<h2 align="center">🐳 Dockerサンドボックスで動作</h2>
<p align="center">各エージェントはマイクロVM内の独立したコンテナで実行されます。<br>ハイパーバイザーレベルの分離。ミリ秒で起動。複雑なセットアップ不要。</p>

**macOS (Apple Silicon)**
```bash
curl -fsSL https://nanoclaw.dev/install-docker-sandboxes.sh | bash
```

**Windows (WSL)**
```bash
curl -fsSL https://nanoclaw.dev/install-docker-sandboxes-windows.sh | bash
```

> 現在、macOS（Apple Silicon）とWindows（x86）に対応しています。Linux対応は近日公開予定。

<p align="center"><a href="https://nanoclaw.dev/blog/nanoclaw-docker-sandboxes">発表記事を読む →</a>&nbsp; · &nbsp;<a href="docs/docker-sandboxes.md">手動セットアップガイド →</a></p>

---

## NanoClawを作った理由

[OpenClaw](https://github.com/openclaw/openclaw)は素晴らしいプロジェクトですが、理解しきれない複雑なソフトウェアに自分の生活へのフルアクセスを与えたまま安心して眠れるとは思えませんでした。OpenClawは約50万行のコード、53の設定ファイル、70以上の依存関係を持っています。セキュリティはアプリケーションレベル（許可リスト、ペアリングコード）であり、真のOS レベルの分離ではありません。すべてが共有メモリを持つ1つのNodeプロセスで動作します。

NanoClawは同じコア機能を提供しますが、理解できる規模のコードベースで実現しています：1つのプロセスと少数のファイル。Claudeエージェントは単なるパーミッションチェックの背後ではなく、ファイルシステム分離された独自のLinuxコンテナで実行されます。

## クイックスタート

```bash
gh repo fork qwibitai/nanoclaw --clone
cd nanoclaw
claude
```

<details>
<summary>GitHub CLIなしの場合</summary>

1. GitHub上で[qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw)をフォーク（Forkボタンをクリック）
2. `git clone https://github.com/<あなたのユーザー名>/nanoclaw.git`
3. `cd nanoclaw`
4. `claude`

</details>

その後、`/setup`を実行します。Claude Codeがすべてを処理します：依存関係、認証、コンテナセットアップ、サービス設定。

> **注意:** `/`で始まるコマンド（`/setup`、`/add-whatsapp`など）は[Claude Codeスキル](https://code.claude.com/docs/en/skills)です。通常のターミナルではなく、`claude` CLIプロンプト内で入力してください。Claude Codeをインストールしていない場合は、[claude.com/product/claude-code](https://claude.com/product/claude-code)から入手してください。

## 設計思想

**理解できる規模。** 1つのプロセス、少数のソースファイル、マイクロサービスなし。NanoClawのコードベース全体を理解したい場合は、Claude Codeに説明を求めるだけです。

**分離によるセキュリティ。** エージェントはLinuxコンテナ（macOSではApple Container、またはDocker）で実行され、明示的にマウントされたものだけが見えます。コマンドはホストではなくコンテナ内で実行されるため、Bashアクセスは安全です。

**個人ユーザー向け。** NanoClawはモノリシックなフレームワークではなく、各ユーザーのニーズに正確にフィットするソフトウェアです。肥大化するのではなく、オーダーメイドになるよう設計されています。自分のフォークを作成し、Claude Codeにニーズに合わせて変更させます。

**カスタマイズ＝コード変更。** 設定ファイルの肥大化なし。動作を変えたい？コードを変更するだけ。コードベースは変更しても安全な規模です。

**AIネイティブ。**
- インストールウィザードなし — Claude Codeがセットアップを案内。
- モニタリングダッシュボードなし — Claudeに状況を聞くだけ。
- デバッグツールなし — 問題を説明すればClaudeが修正。

**機能追加ではなくスキル。** コードベースに機能（例：Telegram対応）を追加する代わりに、コントリビューターは`/add-telegram`のような[Claude Codeスキル](https://code.claude.com/docs/en/skills)を提出し、あなたのフォークを変換します。あなたが必要なものだけを正確に実行するクリーンなコードが手に入ります。

**最高のハーネス、最高のモデル。** NanoClawはClaude Agent SDK上で動作します。つまり、Claude Codeを直接実行しているということです。Claude Codeは高い能力を持ち、そのコーディングと問題解決能力によってNanoClawを変更・拡張し、各ユーザーに合わせてカスタマイズできます。

## サポート機能

- **マルチチャネルメッセージング** - WhatsApp、Telegram、Discord、Slack、Gmailからアシスタントと会話。`/add-whatsapp`や`/add-telegram`などのスキルでチャネルを追加。1つでも複数でも同時に実行可能。
- **グループごとの分離コンテキスト** - 各グループは独自の`CLAUDE.md`メモリ、分離されたファイルシステムを持ち、そのファイルシステムのみがマウントされた専用コンテナサンドボックスで実行。
- **メインチャネル** - 管理制御用のプライベートチャネル（セルフチャット）。各グループは完全に分離。
- **スケジュールタスク** - Claudeを実行し、メッセージを返せる定期ジョブ。
- **Webアクセス** - Webからのコンテンツ検索・取得。
- **コンテナ分離** - エージェントは[Dockerサンドボックス](https://nanoclaw.dev/blog/nanoclaw-docker-sandboxes)（マイクロVM分離）、Apple Container（macOS）、またはDocker（macOS/Linux）でサンドボックス化。
- **エージェントスウォーム** - 複雑なタスクで協力する専門エージェントチームを起動。
- **オプション連携** - Gmail（`/add-gmail`）などをスキルで追加。

## 使い方

トリガーワード（デフォルト：`@Andy`）でアシスタントに話しかけます：

```
@Andy 毎朝9時に営業パイプラインの概要を送って（Obsidian vaultフォルダにアクセス可能）
@Andy 毎週金曜に過去1週間のgit履歴をレビューして、差異があればREADMEを更新して
@Andy 毎週月曜の朝8時に、Hacker NewsとTechCrunchからAI関連のニュースをまとめてブリーフィングを送って
```

メインチャネル（セルフチャット）から、グループやタスクを管理できます：
```
@Andy 全グループのスケジュールタスクを一覧表示して
@Andy 月曜のブリーフィングタスクを一時停止して
@Andy Family Chatグループに参加して
```

## カスタマイズ

NanoClawは設定ファイルを使いません。変更するには、Claude Codeに伝えるだけです：

- 「トリガーワードを@Bobに変更して」
- 「今後はレスポンスをもっと短く直接的にして」
- 「おはようと言ったらカスタム挨拶を追加して」
- 「会話の要約を毎週保存して」

または`/customize`を実行してガイド付きの変更を行えます。

コードベースは十分に小さいため、Claudeが安全に変更できます。

## コントリビューション

**機能を追加するのではなく、スキルを追加してください。**

Telegram対応を追加したい場合、コアコードベースにTelegramを追加するPRを作成しないでください。代わりに、NanoClawをフォークし、ブランチでコード変更を行い、PRを開いてください。あなたのPRから`skill/telegram`ブランチを作成し、他のユーザーが自分のフォークにマージできるようにします。

ユーザーは自分のフォークで`/add-telegram`を実行するだけで、あらゆるユースケースに対応しようとする肥大化したシステムではなく、必要なものだけを正確に実行するクリーンなコードが手に入ります。

### RFS（スキル募集）

私たちが求めているスキル：

**コミュニケーションチャネル**
- `/add-signal` - Signalをチャネルとして追加

**セッション管理**
- `/clear` - 会話をコンパクト化する`/clear`コマンドの追加（同一セッション内で重要な情報を保持しながらコンテキストを要約）。Claude Agent SDKを通じてプログラム的にコンパクト化をトリガーする方法の解明が必要。

## 必要条件

- macOSまたはLinux
- Node.js 20以上
- [Claude Code](https://claude.ai/download)
- [Apple Container](https://github.com/apple/container)（macOS）または[Docker](https://docker.com/products/docker-desktop)（macOS/Linux）

## アーキテクチャ

```
チャネル --> SQLite --> ポーリングループ --> コンテナ（Claude Agent SDK） --> レスポンス
```

単一のNode.jsプロセス。チャネルはスキルで追加され、起動時に自己登録します — オーケストレーターは認証情報が存在するチャネルを接続します。エージェントはファイルシステム分離された独立したLinuxコンテナで実行されます。マウントされたディレクトリのみアクセス可能。グループごとのメッセージキューと同時実行制御。ファイルシステム経由のIPC。

詳細なアーキテクチャについては、[docs/SPEC.md](docs/SPEC.md)を参照してください。

主要ファイル：
- `src/index.ts` - オーケストレーター：状態、メッセージループ、エージェント呼び出し
- `src/channels/registry.ts` - チャネルレジストリ（起動時の自己登録）
- `src/ipc.ts` - IPCウォッチャーとタスク処理
- `src/router.ts` - メッセージフォーマットとアウトバウンドルーティング
- `src/group-queue.ts` - グローバル同時実行制限付きのグループごとのキュー
- `src/container-runner.ts` - ストリーミングエージェントコンテナの起動
- `src/task-scheduler.ts` - スケジュールタスクの実行
- `src/db.ts` - SQLite操作（メッセージ、グループ、セッション、状態）
- `groups/*/CLAUDE.md` - グループごとのメモリ

## FAQ

**なぜDockerなのか？**

Dockerはクロスプラットフォーム対応（macOS、Linux、さらにWSL2経由のWindows）と成熟したエコシステムを提供します。macOSでは、`/convert-to-apple-container`でオプションとしてApple Containerに切り替え、より軽量なネイティブランタイムを使用できます。

**Linuxで実行できますか？**

はい。DockerがデフォルトのランタイムでmacOSとLinuxの両方で動作します。`/setup`を実行するだけです。

**セキュリティは大丈夫ですか？**

エージェントはアプリケーションレベルのパーミッションチェックの背後ではなく、コンテナで実行されます。明示的にマウントされたディレクトリのみアクセスできます。実行するものをレビューすべきですが、コードベースは十分に小さいため実際にレビュー可能です。完全なセキュリティモデルについては[docs/SECURITY.md](docs/SECURITY.md)を参照してください。

**なぜ設定ファイルがないのか？**

設定の肥大化を避けたいからです。すべてのユーザーがNanoClawをカスタマイズし、汎用的なシステムを設定するのではなく、コードが必要なことを正確に実行するようにすべきです。設定ファイルが欲しい場合は、Claudeに追加するよう伝えることができます。

**サードパーティやオープンソースモデルを使えますか？**

はい。NanoClawはClaude API互換のモデルエンドポイントに対応しています。`.env`ファイルで以下の環境変数を設定してください：

```bash
ANTHROPIC_BASE_URL=https://your-api-endpoint.com
ANTHROPIC_AUTH_TOKEN=your-token-here
```

以下が使用可能です：
- [Ollama](https://ollama.ai)とAPIプロキシ経由のローカルモデル
- [Together AI](https://together.ai)、[Fireworks](https://fireworks.ai)等でホストされたオープンソースモデル
- Anthropic互換APIのカスタムモデルデプロイメント

注意：最高の互換性のため、モデルはAnthropic APIフォーマットに対応している必要があります。

**問題のデバッグ方法は？**

Claude Codeに聞いてください。「スケジューラーが動いていないのはなぜ？」「最近のログには何がある？」「このメッセージに返信がなかったのはなぜ？」これがNanoClawの基盤となるAIネイティブなアプローチです。

**セットアップがうまくいかない場合は？**

問題がある場合、セットアップ中にClaudeが動的に修正を試みます。それでもうまくいかない場合は、`claude`を実行してから`/debug`を実行してください。Claudeが他のユーザーにも影響する可能性のある問題を見つけた場合は、セットアップのSKILL.mdを修正するPRを開いてください。

**どのような変更がコードベースに受け入れられますか？**

セキュリティ修正、バグ修正、明確な改善のみが基本設定に受け入れられます。それだけです。

それ以外のすべて（新機能、OS互換性、ハードウェアサポート、機能拡張）はスキルとしてコントリビューションすべきです。

これにより、基本システムを最小限に保ち、すべてのユーザーが不要な機能を継承することなく、自分のインストールをカスタマイズできます。

## コミュニティ

質問やアイデアは？[Discordに参加](https://discord.gg/VDdww8qS42)してください。

## 変更履歴

破壊的変更と移行ノートについては[CHANGELOG.md](CHANGELOG.md)を参照してください。

## ライセンス

MIT
