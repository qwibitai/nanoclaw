# Intent: Keep per-group agent-runner source in sync

Update `src/container-runner.ts` so the per-group `agent-runner-src` copy is refreshed from `container/agent-runner/src` on each container launch instead of only on first creation.

**Why this matters:**
- The runtime mounts `data/sessions/{group}/agent-runner-src` into `/app/src`
- New MCP tools such as `send_media` will not appear at runtime if this copy is stale
- This fixes the real-world failure mode where repo source was updated but the running container still used an old agent-runner snapshot

**Changes:**
1. Ensure the destination directory exists
2. Always copy the latest agent-runner source into the per-group directory
3. Use recursive copy with overwrite semantics

**Invariants:**
- Preserve existing mount, IPC, session, and permission behavior
- Only change the sync strategy for `agent-runner-src`
- Do not refactor unrelated container startup logic
