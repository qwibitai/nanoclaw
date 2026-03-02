# Phase 3: Tech Debt Fixes — Documentation and Network Binding — Research

**Researched:** 2026-03-02
**Domain:** Node.js WebSocket server network binding, CLAUDE.md agent documentation, TypeScript constructor argument explicitness
**Confidence:** HIGH

## Summary

Phase 3 addresses 4 non-blocking issues identified during the v1.0 milestone audit. All issues have known root causes, confirmed code locations, and straightforward fixes. No new libraries are required.

The phase splits into two distinct problem areas: (1) network-level hardening — restricting WebSocketServer binding from `0.0.0.0` to `localhost` for defense-in-depth; and (2) documentation — improving agent guidance in `groups/better-work/CLAUDE.md` and optionally making the `filesPort` constructor argument explicit in `src/index.ts`. The timing dependency in Flow 5 is a known limitation of the current architecture and the fix is documentation-only (no code change needed).

**Primary recommendation:** Fix all 4 issues in a single plan. Three are one-liners (network binding, constructor arg, CLAUDE.md), and one is documentation-only (timing limitation). No architectural changes required.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `ws` | already installed | WebSocket server | already in use — no new dep |
| Node.js `http` module | built-in | File server (already used) | already in use |

### Supporting
No new libraries required for any of the 4 fixes.

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `host: 'localhost'` in ws options | firewall rules / launchd socket activation | Firewall is a system-level concern; code-level binding is the right fix for localhost-only intent |

**Installation:**
No new packages needed.

## Architecture Patterns

### Issue 1: WEBSOCKET_FILES_PORT not passed explicitly in main()

**Current code** (`src/index.ts:530`):
```typescript
const wsChannel = new WebSocketChannel(WEBSOCKET_PORT, {
  onMessage: channelOpts.onMessage,
  onChatMetadata: channelOpts.onChatMetadata,
});
```

The constructor signature is:
```typescript
constructor(
  private readonly port: number,
  private readonly opts: WebSocketChannelOpts,
  private readonly filesPort: number = WEBSOCKET_FILES_PORT,
)
```

`filesPort` defaults to the config value, so it works — but the wiring is implicit. The fix is to pass `WEBSOCKET_FILES_PORT` as a third argument. This also requires importing `WEBSOCKET_FILES_PORT` in `src/index.ts` (or confirming it is already imported).

**Fix:**
```typescript
// Source: src/index.ts line 530
const wsChannel = new WebSocketChannel(WEBSOCKET_PORT, {
  onMessage: channelOpts.onMessage,
  onChatMetadata: channelOpts.onChatMetadata,
}, WEBSOCKET_FILES_PORT);
```

Check if `WEBSOCKET_FILES_PORT` is already imported at the top of `src/index.ts`. If not, add it to the import from `./config.js`.

### Issue 2: WebSocketServer Binds to All Interfaces

**Current code** (`src/channels/websocket.ts:160`):
```typescript
this.wss = new WebSocketServer({ port: this.port });
```

When `host` is omitted, the `ws` library passes `undefined` to Node's `net.Server`, which defaults to `0.0.0.0` — listening on all network interfaces. The file server already correctly binds to `127.0.0.1:3002` (line 108). The WS server should match.

**Fix:**
```typescript
// Source: src/channels/websocket.ts
this.wss = new WebSocketServer({ host: 'localhost', port: this.port });
```

`'localhost'` resolves to `127.0.0.1` on IPv4 (and `::1` on IPv6-preferred systems). Using `'127.0.0.1'` directly is equally correct and more explicit — either is acceptable. Prefer `'127.0.0.1'` to match the file server binding and avoid IPv6 ambiguity.

**Confirmed behavior** (HIGH confidence): The `ws` library passes `host` directly to `net.Server.listen()`. Node's documentation confirms omitting host binds to all interfaces.

### Issue 3: CLAUDE.md Missing Attachment Path Documentation

**Current content** (`groups/better-work/CLAUDE.md`):
```
## Filesystem
Tienes acceso al filesystem del grupo en /workspace/group/.
```

The agent doesn't know about the inbox/attachments convention for received files, nor the files/ directory for outbound files.

**Fix:** Add a Filesystem section that documents both directories and their conventions:

```markdown
## Filesystem

Tienes acceso al filesystem del grupo en `/workspace/group/`.

### Directorios clave

- `/workspace/group/inbox/attachments/` — archivos enviados por el usuario (entrantes). Cada archivo tiene prefijo `{timestamp}-{hex}-{nombre}`. Lee desde aquí cuando el mensaje incluye una referencia `[Attachment: inbox/attachments/...]`.
- `/workspace/group/files/` — archivos que quieres compartir de vuelta al usuario (salientes). Guarda aquí cualquier archivo generado; el sistema lo servirá automáticamente via HTTP e incluirá la URL en el mensaje de respuesta. Referencia el archivo en tu respuesta como `files/nombre-del-archivo.ext`.
```

### Issue 4: File Download Timing Dependency (documentation only)

**Current behavior** (`src/channels/websocket.ts:145`):
```typescript
if (fs.existsSync(fullPath)) {
  attachments.push({ name: path.basename(filename), url: `/files/${filename}` });
}
```

If the agent writes a file but mentions it in the response before the OS has flushed the write to disk, `fs.existsSync()` returns false and the attachment URL is omitted. The text still reaches the panel.

**Fix:** Documentation only — no code change. Document this limitation in `groups/better-work/CLAUDE.md`:

```markdown
### Archivos salientes — orden de operaciones

Escribe siempre el archivo a disco **antes** de mencionar `files/nombre.ext` en tu respuesta. Si mencionas el archivo antes de que esté escrito, la URL no se incluirá en el mensaje estructurado (aunque el texto llegará igualmente al panel).
```

This is the documented limitation from the audit. A code fix (e.g., retry loop, file watcher) would add complexity not justified by the current v1 scope.

### Anti-Patterns to Avoid

- **Changing the constructor signature**: Do not add `filesPort` as a required arg — keep the default. Only pass it explicitly at call sites.
- **Using `'localhost'` when the system resolves it to `::1`**: On macOS, `localhost` can resolve to IPv6 `::1` in some configurations. `'127.0.0.1'` is safer and matches the file server.
- **Over-documenting CLAUDE.md**: Keep it concise. The agent doesn't need the full implementation details — only the paths and conventions needed to use the system correctly.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Network interface restriction | Custom socket wrapper | `host` option in `WebSocketServer` constructor | One-liner; ws passes it directly to Node's net.Server |
| File timing | Retry loop or file watcher | Documentation + agent discipline | Adds complexity; the write-then-respond pattern is easy to follow |

**Key insight:** All 4 issues are surface-level. The underlying architecture is sound. No structural changes needed.

## Common Pitfalls

### Pitfall 1: IPv6 Ambiguity with 'localhost'

**What goes wrong:** On macOS (Darwin), `/etc/hosts` maps `localhost` to both `127.0.0.1` and `::1`. Node.js `net.Server.listen()` resolves `'localhost'` and may bind to `::1` if the system prefers IPv6. A client connecting to `ws://localhost:3001` on IPv4 would fail if the server is on `::1`.

**Why it happens:** `localhost` is not an IP — it's a hostname that resolves via DNS/hosts.

**How to avoid:** Use `'127.0.0.1'` explicitly, matching the file server binding. Consistent, unambiguous.

**Warning signs:** Connection refused on localhost when server is running (different address family).

### Pitfall 2: Import Not Added for WEBSOCKET_FILES_PORT in index.ts

**What goes wrong:** Adding the third argument to the `WebSocketChannel` constructor call in `index.ts` without importing `WEBSOCKET_FILES_PORT` from `./config.js` causes a compile error.

**Why it happens:** The constant is currently imported only inside `websocket.ts` itself.

**How to avoid:** Check existing imports at the top of `src/index.ts` before editing the constructor call.

**Warning signs:** TypeScript error `Cannot find name 'WEBSOCKET_FILES_PORT'`.

### Pitfall 3: Overwriting Agent Memory in CLAUDE.md

**What goes wrong:** Replacing the entire CLAUDE.md instead of appending to it loses the existing agent persona and language instructions.

**Why it happens:** Using Write instead of Edit on an existing file.

**How to avoid:** Use Edit to append the new Filesystem section. Preserve all existing content.

## Code Examples

### Verified: ws WebSocketServer host option

```typescript
// Bind to localhost only (IPv4)
this.wss = new WebSocketServer({ host: '127.0.0.1', port: this.port });
```

Consistent with file server binding pattern already in codebase:
```typescript
// websocket.ts:108 — file server already uses 127.0.0.1
this.fileServer.listen(this.filesPort, '127.0.0.1');
```

### Verified: Explicit filesPort constructor arg

```typescript
// src/index.ts — before
const wsChannel = new WebSocketChannel(WEBSOCKET_PORT, {
  onMessage: channelOpts.onMessage,
  onChatMetadata: channelOpts.onChatMetadata,
});

// src/index.ts — after
const wsChannel = new WebSocketChannel(WEBSOCKET_PORT, {
  onMessage: channelOpts.onMessage,
  onChatMetadata: channelOpts.onChatMetadata,
}, WEBSOCKET_FILES_PORT);
```

## State of the Art

No library updates required. All changes are configuration/code clarity fixes within existing patterns.

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Implicit filesPort default | Explicit filesPort arg at call site | Phase 3 | No behavior change — clarity only |
| `0.0.0.0` WS binding | `127.0.0.1` WS binding | Phase 3 | Defense-in-depth — no functional change for local use |

## Open Questions

1. **WEBSOCKET_FILES_PORT already imported in index.ts?**
   - What we know: `WEBSOCKET_FILES_PORT` is exported from `src/config.ts`
   - What's unclear: Whether `src/index.ts` already imports it (not visible in the excerpt read)
   - Recommendation: Check the import block at the top of `src/index.ts` before editing. Add to import if missing.

## Sources

### Primary (HIGH confidence)
- Direct code inspection: `src/channels/websocket.ts` — confirmed network binding at line 160, file server at line 108
- Direct code inspection: `src/index.ts:530` — confirmed WebSocketChannel constructor call without filesPort
- Direct code inspection: `groups/better-work/CLAUDE.md` — confirmed missing attachment path documentation
- `.planning/v1.0-MILESTONE-AUDIT.md` — 4 issues with exact locations and recommendations

### Secondary (MEDIUM confidence)
- Node.js `net.Server.listen()` docs: omitting host binds to all interfaces (`0.0.0.0`)
- `ws` library: `host` option passed directly to `net.Server`

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new libraries, all existing code
- Architecture: HIGH — exact line numbers and fixes verified from source
- Pitfalls: HIGH — IPv6 ambiguity is a known macOS behavior; import pitfall is TypeScript compile-time

**Research date:** 2026-03-02
**Valid until:** Until Phase 3 is planned — no external dependencies, internal code only
