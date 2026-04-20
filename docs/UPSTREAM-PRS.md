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
