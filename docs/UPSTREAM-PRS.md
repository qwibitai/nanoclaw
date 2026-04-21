# Upstream Extension Point PRs

Tracks anchor patches we owe upstream as proper extension point PRs.
Once accepted upstream, the corresponding `.nanoclaw-migrations/guide.md` entry can be removed.

## Identity Layer

### 1. NewMessage identity fields (src/types.ts)
**Status:** Not yet submitted  
**Proposal:** Add `canonical_id?: string` and `roles?: string[]` as optional fields to `NewMessage`.  
**Upstream benefit:** Any fork wanting identity resolution can use these fields without patching types.

### 2. Identity wrapper hook (src/channels/registry.ts)
**Status:** Not yet submitted  
**Proposal:** Export `setIdentityWrapper(fn)` to allow channel factories to be decorated at registration time.  
**Upstream benefit:** Enables pluggable channel middleware (identity, logging, rate limiting) without core changes.

### 3. Identity attributes in message XML (src/router.ts)
**Status:** Not yet submitted  
**Proposal:** Render `id` and `roles` attributes on `<message>` when present on `NewMessage`.  
**Upstream benefit:** LLMs can use caller identity in responses without custom router patches.

### 4. Caller identity env vars (src/container-runner.ts)
**Status:** Not yet submitted  
**Proposal:** Pass `NANOCLAW_CALLER_ID` and `NANOCLAW_CALLER_ROLES` env vars into agent containers from `ContainerInput`.  
**Upstream benefit:** MCP servers inside containers can authorize tool calls based on the triggering user's identity.

## Policy Layer

### 5. Policy anchor in src/ipc.ts
**Status:** Not yet submitted  
**Proposal:** Add `callerId?`/`callerRoles?` to processTaskIpc data, `callerCanDo(capability)` helper, and replace isMain checks with capability checks.  
**Upstream benefit:** Any fork wanting RBAC on IPC operations can add it without patching the monolith.

### 6. Policy anchor in src/index.ts::handleRemoteControl
**Status:** Not yet submitted  
**Proposal:** OR-gate `checkCapability` alongside `group.isMain` in handleRemoteControl.  
**Upstream benefit:** Remote-control access can be granted to non-main-group admin users.

## Almanda Persona Layer

### 7. Global CLAUDE.md for all groups (container/agent-runner/src/index.ts)
**Status:** Not yet submitted  
**Proposal:** Remove `!containerInput.isMain` guard so `groups/global/CLAUDE.md` is appended to `systemPrompt` for all groups, including main.  
**Upstream benefit:** Forks wanting a shared persona or global operating rules across all groups (main + non-main) can do so without forking the agent runner per-group. The current guard silently skips the global file for main with no log indication — a footgun for forks that rely on global CLAUDE.md for shared behavior.

## MCP Integration Layer

### 8. Optional MCP env-var forwarding (src/container-runner.ts)
**Status:** Not yet submitted  
**Proposal:** Add a typed `mcpEnvVars` array near the TZ forwarding block that passes named env vars to the container via `-e` when set on the host. Forks can add to the array without touching the surrounding logic.  
**Upstream benefit:** Currently the only way to pass credentials to container-side MCP servers is OneCLI. Forks without OneCLI (dev setups, self-hosted deployments) have no clean hook to forward their own API keys. A small extension-point array keeps the change minimal and makes the pattern visible rather than scattered.

**Alma fork note (add-slack-ops):** `SLACK_MCP_ADD_MESSAGE_TOOL=true` is now set on the `slack-intel` MCP block in `container/agent-runner/src/index.ts:530`. This enables `conversations_add_message`, `reactions_add`, and `reactions_remove` tools. No new env-var forwarding anchor was needed (SLACK_BOT_TOKEN was already in the allowlist).
