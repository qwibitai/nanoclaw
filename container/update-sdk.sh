#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORK_DIR="$SCRIPT_DIR/agent-runner/.open-agent-sdk-fork"
RUNNER_DIR="$SCRIPT_DIR/agent-runner"

echo "=== open-agent-sdk フォーク更新スクリプト ==="

# 1. フォーク内の core をビルド
echo ""
echo "[1/3] packages/core をビルド中..."
cd "$FORK_DIR"
bun run build

# 2. tgz を再パック
echo ""
echo "[2/3] tgz を再パック中..."
cd "$FORK_DIR/packages/core"
npm pack --pack-destination "$FORK_DIR"
TGZ_FILE=$(ls "$FORK_DIR"/open-agent-sdk-*.tgz 2>/dev/null | head -1)
if [[ -z "$TGZ_FILE" ]]; then
    echo "エラー: tgz ファイルが見つかりません" >&2
    exit 1
fi
mv "$TGZ_FILE" "$FORK_DIR/open-agent-sdk-fork.tgz"
echo "パック完了: open-agent-sdk-fork.tgz"

# 3. agent-runner の依存関係を再インストール
echo ""
echo "[3/3] agent-runner の依存関係を更新中..."
cd "$RUNNER_DIR"
npm install

echo ""
echo "=== SDK 更新完了 ==="
echo ""
echo "コンテナを再ビルドするには:"
echo "  ./container/build.sh"
echo ""
read -p "コンテナを今すぐ再ビルドしますか？ [y/N] " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "コンテナを再ビルド中..."
    cd "$SCRIPT_DIR"
    ./build.sh
    echo "コンテナ再ビルド完了"
fi
