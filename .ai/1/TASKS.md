# Tasks
## Summary
PR #34 の Copilot レビュー指摘を解消し、シークレット分離強化・_close プリエンプションの正確化・IPC フォローアップ反映・関連ドキュメント整備を完了する。

## Tasks
### 1. Gemini/Codex のシークレット分離ポリシーを是正する
- Why: Acceptance Criteria 4（高優先度セキュリティ）で、`GEMINI_API_KEY` と `OAS_CODEX_OAUTH_JSON` のコンテナ直接注入を見直し、デフォルトで安全な取り扱いへ修正する必要があるため。
- What: プロバイダー設定とコンテナ環境変数生成の契約を更新し、Gemini/Codex の認証情報を Anthropic/OpenAI と同等の分離方針、または明示的オプトイン前提の方針に統一する。必要な利用者向けリスク説明も整備する。
- Done when: Gemini/Codex の認証情報がデフォルトでコンテナへ露出しない、または明示フラグなしで起動拒否される状態になっており、Anthropic/OpenAI の既存プレースホルダー方式が維持されている。

### 2. _close センチネル時の出力抑止と終了シグナルを統一する
- Why: Acceptance Criteria 3 & 5（高優先度バグ修正）で、`_close` 受信後に不要な OUTPUT マーカーが出てホスト側アクティビティとして扱われる問題を解消する必要があるため。
- What: `runQuery()` と `main()` の終了判定を連動させ、`_close` 検知時はクエリ結果出力・セッション更新出力の双方が抑止されるように、終了シグナルの受け渡し契約を明確化する。
- Done when: `_close` 検知後は `runQuery()` から終了シグナルが返り、`main()` は追加の `writeOutput` を行わずループを終了し、ホスト側のアイドルタイマーを不要に延命する出力が発生しない。

### 3. 長時間ストリーム中の IPC フォローアップ反映を保証する
- Why: Acceptance Criteria 2（中優先度機能改善）で、実行中に届いた追撃メッセージがストリーム完了まで無視される遅延を解消する必要があるため。
- What: アクティブセッション実行中でも IPC 入力を継続的に取り込み、到着したフォローアップをセッションへ反映できる処理契約に更新する。
- Done when: 長時間のツール/LLM 実行中にホストから送信したメッセージがストリーム終了待ちにならず、実行中セッションに取り込まれることが確認できる。

### 4. Open Agent SDK DeepWiki ドキュメントの Monorepo 表記を修正する
- Why: Acceptance Criteria 1（低優先度ドキュメント）で、Monorepo Structure の記述不整合を解消する必要があるため。
- What: `docs/OasAIStudio-open-agent-sdk/OasAIStudio-open-agent-sdk-deepwiki.md` の Monorepo Structure セクションを見直し、パッケージパスを特定できる項目は明記し、特定不能な場合は不正確な表記を除去する。
- Done when: Monorepo Structure セクションに空欄や不整合が残っておらず、読者が各コンポーネントの位置関係を誤解しない状態になっている。

---