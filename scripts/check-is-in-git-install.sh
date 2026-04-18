#!/usr/bin/env bash
# Exit 0 if this `prepare` run is a git-dependency install; non-zero otherwise.
# Mirrors the heuristic used by openai-node and anthropic-sdk-typescript:
#   - npm clones git deps under `$HOME/.npm/_cacache/tmp/git-cloneXXXX`
#   - yarn uses `$(yarn cache dir)/.tmp/XXXXX`
#   - pnpm symlinks the extracted package into `node_modules/...`
# Contributors can force-skip with AGENTLITE_DEV=1, force-build with AGENTLITE_BUILD=1.

if [ -n "$AGENTLITE_DEV" ]; then
  exit 1
fi

if [ -n "$AGENTLITE_BUILD" ]; then
  exit 0
fi

parent_name="$(basename "$(dirname "$PWD")")"
[ "$parent_name" = 'node_modules' ] ||
[ "$parent_name" = 'tmp' ] ||
[ "$parent_name" = '.tmp' ]
