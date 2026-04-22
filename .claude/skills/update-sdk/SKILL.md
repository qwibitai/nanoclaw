---
name: update-sdk
description: open-agent-sdk フォークを git pull して再ビルドし、コンテナイメージを更新する。
---

# About

`container/agent-runner/.open-agent-sdk-fork` にある open-agent-sdk フォークをリモートの最新状態に追従させ、コンテナイメージに反映する。

Run `/update-sdk` in Claude Code.

---

# Goal

open-agent-sdk フォークの pull → SDK ビルド → bun.lock 再生成 → コンテナ再ビルドを一発で完了させる。

# Operating principles

- すべてのコマンドはプロジェクトルートを基準とした絶対パスで実行する。
- `bun.lock` と `package-lock.json` は必ず削除して再生成する（古いハッシュを引き継がないため）。
- `update-sdk.sh` のインタラクティブな質問（コンテナ再ビルドするか）には `n` を渡してスキップし、スキルが自分でビルドする。
- エラーが発生したら即座に止めてユーザーに報告する。

# Step 1: フォークを pull

```
cd container/agent-runner/.open-agent-sdk-fork && git pull
```

コミット数と更新されたファイルの概要をユーザーに表示する。
すでに最新（Already up to date）の場合は、その旨を伝えてユーザーに続行するか確認する。

# Step 2: SDK をビルドして tgz を再パック

```
cd container && bash update-sdk.sh <<< "n"
```

`=== SDK 更新完了 ===` が出力されれば成功。エラーがあれば止まって報告する。

# Step 3: bun.lock と package-lock.json を再生成

古いハッシュが残っていると `bun install --frozen-lockfile` が失敗するため、必ず削除してから再生成する。

```
cd container/agent-runner && rm -f bun.lock package-lock.json && bun install
```

インストール完了後、`bun.lock` に新しい `sha512-` ハッシュが書き込まれたことを確認する：

```
grep "open-agent-sdk.*sha512" container/agent-runner/bun.lock
```

# Step 4: Docker ビルドキャッシュを prune してコンテナ再ビルド

古いキャッシュが COPY ステップを再利用してハッシュ不一致を引き起こすため、prune してからビルドする。

```
docker builder prune -f
```

```
cd container && bash build.sh
```

`Build complete!` が出力されれば成功。

# Step 5: 完了報告

以下を表示する：
- pull で取り込んだコミット数とハイライト（新機能・変更点）
- 新しい `open-agent-sdk` の sha512 ハッシュ（短縮表示）
- ビルドされたイメージ名（`nanoclaw-agent:latest`）
- サービス再起動が必要な場合はその手順：
  - Linux (systemd): `systemctl --user restart nanoclaw`
  - macOS (launchd): `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
