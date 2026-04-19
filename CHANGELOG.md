# Changelog

All notable changes to NanoClaw will be documented in this file.

## [Unreleased] - shin902 Fork Changes

### Breaking Changes

- **feat:** open-agent-sdkへの移行（Bunランタイム対応）
  - エージェントコンテナをNode.jsからBunに移行
  - `/home/node/.claude`から`/home/bun/.claude`へのパス変更
  - forkされたopen-agent-sdkをtarball経由で利用
- **refactor:** `isMain`を`GroupType`に置き換え（`override`/`main`/`chat`/`thread`）

### Added

- **feat:** 複数LLMプロバイダー対応（OpenAI, Anthropic, Google Gemini, Codex）
- **feat:** Codex認証のサポート追加
- **feat:** IPCフォローアップ機能と`_close`検知の改善
- **feat:** 直接認証情報注入のオプトイン対応（`ALLOW_DIRECT_SECRET_INJECTION`）
- **feat:** コンテナビルド・更新の自動化スクリプト追加（`scripts/update-open-agent-sdk.sh`）
- **feat:** `parent_folder`サポート（親フォルダのマウント）
- **feat:** Discord URL投稿時の自動スレッド作成（url_watch機能）
- **feat:** `thread_per_message`モードでのURL自動検出とマークダウン保存
- **feat:** Discordスレッドを派生グループとして自動登録（`thread`グループタイプ）
- **feat:** グループタイプシステム（`override`/`main`/`chat`/`thread`）
- **feat:** チャンネル別エージェント分離設定
- **feat:** VRC-AI-Bot由来のPlaceType/ActorRole型をDiscordチャンネルに導入
- **docs:** READMEに日本語訳とフォークの目的・特徴を追加
- **docs:** `.env.example`に詳細な環境変数コメント（日本語訳付き）を追加
- **docs:** `SECURITY.md`に直接認証情報注入のオプトイン要件を追加
- **docs:** スレッドベースアーキテクチャの設計ドキュメント追加

### Changed

- **refactor:** `url_watch`を`thread_per_message`に統合・移行
- **refactor:** IPC namespaceエンコーディング/デコーディングの改善（chat JID対応）
- **refactor:** `spawnThreadForUrl`関数のURL検出ロジック最適化（グローバル正規表現使用）
- **refactor:** NewMessageからDiscord固有フィールドをInboundMessageに分離
- **refactor:** コード整形と可読性の向上
- **refactor:** `assertDirectSecretInjectionAllowed`関数の可読性向上
- **docs:** Open Agent SDK deepwikiのモノレポ構造テーブルを更新
- **docs:** Dockerfileのクレデンシャル注入コメントをプロバイダー別に更新

### Fixed

- **fix:** `.env`に不足しているプロバイダー認証情報のエラーメッセージを改善
- **fix:** Dockerコンテナの書き込み可能ディレクトリの所有権を`bun`ユーザーに設定
- **fix:** URLウォッチの初期スレッド処理と信頼性の問題を修正
- **fix:** `url_watch`のFK制約問題と初期化の一貫性を改善
- **fix:** WhatsAppセッションキーのマイグレーション問題を修正
- **fix:** ストリーミングモードでのメッセージ処理遅延を改善
- **fix:** `credential-proxy`の`ETIMEDOUT`対策と接続エラー処理を改善
- **fix:** `thread_defaults`のcontainerConfig検証をIPCに追加

### Security

- **security:** Gemini/Codexの直接シークレット注入をゲート制御
- **security:** `_close`先制時の機密出力を抑制

---

## [1.2.0](https://github.com/qwibitai/nanoclaw/compare/v1.1.6...v1.2.0) - Upstream

[BREAKING] WhatsApp removed from core, now a skill. Run `/add-whatsapp` to re-add (existing auth/groups preserved).

- **fix:** Prevent scheduled tasks from executing twice when container runtime exceeds poll interval (#138, #669)
