# 仕様書: PR #34 Copilot レビュー指摘事項の修正

## Goal

PR #34（Open Agent SDK への移行）に対する Copilot レビューの指摘事項を解消し、セキュリティリスクの低減・プリエンプション動作の正確化・IPC フォローアップ処理の改善を達成する。

---

## Context

- 対象リポジトリ: `shin902/nanoclaw`
- 対象ブランチ: `feat/migrate-open-agent-sdk`
- このPRはコンテナ側のエージェントランナーをレガシー Claude Agent SDK から Open Agent SDK (OAS) に移行し、複数 LLM プロバイダー対応（Anthropic / OpenAI / Gemini / Codex）と Bun ベースの依存管理を追加している
- 既存のシークレット分離設計: `src/env.ts` はシークレットを `process.env` に載せず、`.env` から直接読んで呼び出し元に返す設計。Anthropic / OpenAI は `credential-proxy` 経由でプレースホルダーをコンテナに渡し、実 API キーはホスト側のみが保持する
- Gemini / Codex は SDK の制約（BaseURL 上書き非対応）により現状は実 API キーをコンテナ環境変数に直接注入しているが、これがレビュー指摘の対象
- `container/agent-runner/src/index.ts` の `runQuery()` と `main()` の制御フローにプリエンプション処理と IPC ポーリングのギャップがある

---

## Acceptance Criteria

### 優先度: 高（セキュリティ）

#### 4. Gemini / Codex のシークレット分離

- [ ] `buildContainerProviderEnv()` が `GEMINI_API_KEY` / `OAS_CODEX_OAUTH_JSON` を直接コンテナ環境変数に注入している現状を変更する
- [ ] 下記いずれかの方式で対応する（実装方式の選択は実装者に委ねる）:
  - **方式 A (credential-proxy 拡張)**: `credential-proxy.ts` を Gemini / Codex プロバイダー向けに拡張し、コンテナへはプレースホルダーのみ渡す。プロキシがリクエストに実 API キーを付加する
  - **方式 B (明示的オプトインフラグ)**: 直接注入を維持する場合、`.env` に `ALLOW_DIRECT_SECRET_INJECTION=true` 等の明示フラグが必要で、フラグなしは起動拒否。合わせてドキュメントにリスクと回避策を記載する
- [ ] Anthropic / OpenAI の既存プレースホルダー方式は変更しない

### 優先度: 高（バグ修正）

#### 3 & 5. `_close` プリエンプション処理の修正

**背景と根本原因の補足（Copilot PR #34 コメント, line 683 より）:**

- ホスト側（`src/container-runner.ts`）は `OUTPUT_START_MARKER` を受信するたびにハードタイムアウトをリセットする（line 433）
- `shouldClose()` は `_close` センチネルファイルを**削除しながら読む消費型**（delete-on-read）設計のため、一度 `true` を返すと以降は常に `false` を返す
- ストリームループ内（`for await`）で `shouldClose()` が `true` を返してファイルを削除した後、その下流の `writeOutput()` 前チェック（line 778）でも `shouldClose()` を呼んでいるが、ファイルはすでに消えているため `false` になるリスクがある
- `requestExit()` が `shouldExit = true` にセットするフローは存在するが、`stopIpcPolling()` 後から `writeOutput()` 呼び出しまでの `await followupSendChain`（line 776）の間にセンチネルが届いた場合、バックグラウンドポーリングはすでに停止しているため検知できない
- 結果として、closeシグナルが届いた後も `writeOutput()` が実行され、ホスト側のタイムアウトがリセットされ、古いコンテナが動き続ける可能性がある

**Acceptance Criteria:**

- [ ] `writeOutput()` の呼び出し直前のガードは `shouldClose()` の再呼び出しに依存せず、**`shouldExit` フラグのみを参照する**形で機能すること
- [ ] `stopIpcPolling()` 後から `writeOutput()` 直前までのウィンドウで `_close` センチネルが届いた場合にも `writeOutput()` がスキップされること（`await followupSendChain` 完了後に再チェックするか、またはその他の確実な方法で対応する）
- [ ] `runQuery()` がストリーミング完了後に OUTPUT マーカーを出力するのは `shouldExit` が `false` の場合のみ
- [ ] 結果として、`_close` センチネル受信後はホスト側のハードタイムアウトをリセットさせる OUTPUT マーカーが出力されない
- [ ] 既存の「ストリームループ中に `_close` を検知したら `break` してリターン」の動作は維持する

### 優先度: 中（機能改善）

#### 2. IPC フォローアップメッセージのポーリング

- [ ] `session.stream()` の `for await` ループ内で、各メッセージ受信のたびに `drainIpcInput()` を呼び出し、蓄積された IPC メッセージをアクティブセッションに転送（`session.send()`）する
- [ ] または、ホスト側の `GroupQueue.sendMessage()` が IPC 書き込みのタイミングをストリーム完了後に遅延させる方式でも可（実装者に委ねる）
- [ ] いずれの方式でも、長時間のツール / LLM 実行中にホストが送信したメッセージがストリーム終了まで無視されないことを保証する

### 優先度: 低（ドキュメント）

#### 1. Monorepo Structure テーブルの修正

- [ ] `docs/OasAIStudio-open-agent-sdk/OasAIStudio-open-agent-sdk-deepwiki.md` の "Monorepo Structure" テーブルで "Package Path" 列が空になっている
- [ ] パッケージのパスが特定できる場合は正しいパスを記入する。特定できない場合はテーブルごと削除する

---

## Out of Scope

- Gemini / Codex 以外のプロバイダー（Anthropic / OpenAI）の credential-proxy 実装への変更
- OAS 以外の他 SDK への移行
- IPC プロトコル自体の仕様変更
- 既存のテストの大規模リファクタリング
- 新規プロバイダーの追加

---

## Notes

- 修正の優先順位は セキュリティ (4) > バグ修正 (3, 5) > 機能改善 (2) > ドキュメント (1) の順で着手すること
- 指摘 3 と 5 は同一の制御フロー問題を異なる観点から指摘しているため、まとめて一つの修正として対応してよい
- `credential-proxy.ts` を拡張する場合（方式 A）、Google の API 認証方式（Bearer ヘッダー vs API キークエリパラメータ）を事前に調査すること
- コンテナ側（`container/agent-runner/src/index.ts`）の変更後は `./container/build.sh` によるイメージ再ビルドが必要
