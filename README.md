<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  パーソナルAIエージェント。自分用にカスタマイズしたNanoClawフォーク。
</p>

---

## このフォークについて

これは**パーソナルなAIエージェント**です。

- **自分が使いやすいと思う機能だけ**を実装しています
- **必要ない機能は追加しません**
- **破壊的変更も頻繁にします**

このリポジトリは個人的な用途に最適化されており、他の人のユースケースを考慮していません。

## クイックスタート

```bash
npm install
npm run dev
```

初回セットアップ時は Claude Code で `/setup` を実行してください。

## 機能

- **マルチチャンネルメッセージング** - WhatsApp、Telegram、Discord、Slack、Gmailからアシスタントと会話
- **隔離されたグループコンテキスト** - 各グループは独自の `CLAUDE.md` メモリと隔離されたファイルシステム
- **スケジュールされたタスク** - 定期ジョブの実行
- **コンテナ隔離** - Apple Container（macOS）またはDockerでエージェントをサンドボックス化

## 使い方

トリガーワード（デフォルト：`@Andy`）でアシスタントと会話：

```
@Andy 平日の朝9時にタスク一覧を送信して
@Andy 毎週金曜日にgit履歴をレビューして
```

## 要件

- macOS
- Node.js 20+
- [Claude Code](https://claude.ai/download)
- [Apple Container](https://github.com/apple/container) または [Docker](https://docker.com/products/docker-desktop)

## ライセンス

MIT
