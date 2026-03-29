#!/bin/bash
# Harness v3 pre-tool shim
# Delegates to core hook engine if present
CORE="$(dirname "$0")/../node_modules/.bin/harness-pre-tool"
[ -x "$CORE" ] && exec "$CORE" "$@"
exit 0
