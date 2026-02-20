#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../../../.."

if [ ! -d .nanoclaw ]; then
  npx tsx scripts/apply-skill.ts --init
fi

npx tsx scripts/apply-skill.ts .claude/skills/add-slack

