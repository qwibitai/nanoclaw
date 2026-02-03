#!/bin/bash
# NanoClaw 重启脚本
# 自动处理 token 更新、会话清理、构建和服务重启

set -e

cd "$(dirname "$0")/.."

echo "=== NanoClaw 重启脚本 ==="
echo ""

# 1. 更新 OAuth Token
echo "[1/5] 更新 OAuth Token..."
TOKEN=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null | jq -r '.claudeAiOauth.accessToken' 2>/dev/null || echo "")

if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
    echo "  ⚠️  无法从 Keychain 获取 token，跳过更新"
else
    # 更新或添加 token（保留其他变量）
    if grep -q "^CLAUDE_CODE_OAUTH_TOKEN=" .env 2>/dev/null; then
        sed -i '' "s|^CLAUDE_CODE_OAUTH_TOKEN=.*|CLAUDE_CODE_OAUTH_TOKEN=$TOKEN|" .env
    else
        echo "CLAUDE_CODE_OAUTH_TOKEN=$TOKEN" >> .env
    fi
    echo "  ✓ Token 已更新 (${TOKEN:0:20}...)"
fi

# 2. 会话缓存（默认保留）
# 使用 --clean 参数强制清理会话
echo "[2/5] 检查会话缓存..."
if [ "$1" = "--clean" ]; then
    if [ -d "data/sessions/main/.claude" ]; then
        rm -rf data/sessions/main/.claude/*
        echo "  ✓ 已清理 Claude Code 缓存"
    fi
    if [ -f "data/sessions.json" ]; then
        rm -f data/sessions.json
        echo "  ✓ 已删除会话索引"
    fi
else
    echo "  ✓ 保留会话上下文（使用 --clean 强制清理）"
fi

# 3. 重新构建
echo "[3/5] 构建 TypeScript..."
npm run build > /dev/null 2>&1
echo "  ✓ 构建完成"

# 4. 重启服务
echo "[4/5] 重启服务..."
launchctl kickstart -k gui/$(id -u)/com.nanoclaw > /dev/null 2>&1
sleep 2

# 5. 验证服务状态
echo "[5/5] 验证服务状态..."
STATUS=$(launchctl list | grep nanoclaw || echo "")
if [ -n "$STATUS" ]; then
    PID=$(echo "$STATUS" | awk '{print $1}')
    EXIT_CODE=$(echo "$STATUS" | awk '{print $2}')
    if [ "$EXIT_CODE" = "0" ] || [ "$EXIT_CODE" = "-" ]; then
        echo "  ✓ 服务运行中 (PID: $PID)"
    else
        echo "  ✗ 服务异常 (Exit: $EXIT_CODE)"
        exit 1
    fi
else
    echo "  ✗ 服务未找到"
    exit 1
fi

echo ""
echo "=== 重启完成 ==="
