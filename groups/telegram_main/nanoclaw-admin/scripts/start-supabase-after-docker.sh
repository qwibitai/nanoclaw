#!/bin/zsh
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

until docker info >/dev/null 2>&1; do
  sleep 5
done

cd /Users/broseph/dev/nanoclaw/groups/telegram_main/nanoclaw-admin
supabase start -x realtime,storage-api,logflare,vector
