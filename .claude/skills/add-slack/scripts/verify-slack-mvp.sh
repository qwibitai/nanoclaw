#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../../../.."

npm run typecheck
npx vitest run src/channels/slack.test.ts src/routing.test.ts src/channels/whatsapp.test.ts

