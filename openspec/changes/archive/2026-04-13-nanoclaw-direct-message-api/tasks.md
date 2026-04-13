# Tasks: NanoClaw Direct Message API

## Phase 1: Config and Plumbing

### 1.1 Add config exports
**File:** `src/config.ts`
- Add `NANOCLAW_API_TOKEN`, `NANOCLAW_API_PORT`, `NANOCLAW_API_TIMEOUT` to `readEnvFile()` call
- Export `API_PORT` (default 3200), `API_TIMEOUT` (default 120000), `API_TOKEN` (default empty string)
- When `API_TOKEN` is empty, the API channel factory should return `null` (channel disabled)

### 1.2 Update `.env.example`
**File:** `.env.example`
- Add `NANOCLAW_API_TOKEN`, `NANOCLAW_API_PORT`, `NANOCLAW_API_TIMEOUT` with comments

---

## Phase 2: API Channel Implementation

### 2.1 Create `src/channels/api.ts`
**File:** `src/channels/api.ts`

Implement `createApiChannel(opts: ChannelOpts): Channel | null`:

1. **Guard**: Return `null` if `API_TOKEN` is empty (skip channel like Telegram does when token is missing)
2. **HTTP server**: `http.createServer()` on `API_PORT`, bound to `0.0.0.0` (needs to be reachable from Tailscale)
3. **Pending responses map**: `Map<string, PendingRequest>` keyed by `{groupJid}:{requestId}`
   ```typescript
   interface PendingRequest {
     res: http.ServerResponse;
     stream: boolean;
     timer: NodeJS.Timeout;
     startTime: number;
     chunks: string[];
   }
   ```
4. **Route: `POST /api/v1/message`**
   - Validate `Authorization: Bearer <token>` against `API_TOKEN`
   - Parse JSON body, validate required fields (`group`, `sender`, `sender_name`, `content`)
   - Look up group by folder name via `opts.registeredGroups()`
   - Find the group's chat_jid from the registered groups map
   - Generate `requestId` (e.g. `req_${Date.now()}_${crypto.randomUUID().slice(0,8)}`)
   - Store pending request in map
   - Set timeout timer that responds with 408 and cleans up
   - Construct `NewMessage` and call `opts.onMessage(chatJid, message)`
   - Call `opts.onChatMetadata(chatJid, timestamp, undefined, 'api', false)`
   - For `stream=false`: wait for `sendMessage()` to resolve the response
   - For `stream=true`: set SSE headers, push chunks as they arrive via `sendMessage()`
5. **Route: `GET /api/v1/health`**
   - No auth required
   - Return bot name, active container count, registered group count, connected channels, uptime
6. **Channel interface**:
   - `name`: `'api'`
   - `connect()`: Start HTTP server, resolve when listening
   - `sendMessage(jid, text)`: Check if there's a pending API request for this JID. If yes, resolve HTTP response (or push SSE chunk). If no pending request, this is a non-API outbound message — no-op (don't error)
   - `isConnected()`: Return true when HTTP server is listening
   - `ownsJid(jid)`: Return `true` for JIDs that have a pending API request (check the pending map by groupJid). This is the key trick: the API channel "owns" a JID only while there's an active API request for that group
   - `disconnect()`: Stop accepting connections, drain in-flight, close server

**Key design decision for `ownsJid` and `sendMessage`:**
The API channel needs to intercept outbound messages for groups that have pending API requests. Since the router (`routeOutbound`) picks the first channel where `ownsJid()` returns true, the API channel should:
- Override `ownsJid()` to return true when a pending API request exists for the given JID
- In `sendMessage()`, resolve the pending HTTP response instead of sending to a chat platform
- When no pending request exists for a JID, `ownsJid()` returns false, so the router falls through to Telegram/Slack as usual

**Important**: The API channel must be registered BEFORE other channels in the barrel file so it gets priority in `ownsJid()` checks. Alternatively, modify `routeOutbound()` to prefer API channel — but the ordering approach is simpler.

### 2.2 Register in barrel file
**File:** `src/channels/index.ts`
- Add `import './api.js';` at the top (before slack/telegram) so API channel gets `ownsJid` priority
- Add comment: `// api (direct message)`

### 2.3 Self-registration call
**File:** `src/channels/api.ts` (bottom of file)
```typescript
registerChannel('api', createApiChannel);
```

---

## Phase 3: Testing

### 3.1 Unit tests for API channel
**File:** `src/channels/api.test.ts`
- Test: channel returns `null` when `API_TOKEN` is empty
- Test: health endpoint returns 200 with correct shape
- Test: message endpoint rejects missing auth (401)
- Test: message endpoint rejects invalid auth (401)
- Test: message endpoint rejects missing fields (400)
- Test: message endpoint rejects unknown group (404)
- Test: successful message round-trip (mock `onMessage`, call `sendMessage` on the channel, verify HTTP response)
- Test: SSE streaming (send multiple chunks, verify SSE format)
- Test: timeout produces 408
- Test: graceful shutdown rejects new requests with 503

### 3.2 Integration test
**File:** `src/channels/api.integration.test.ts` (optional, if time permits)
- Spin up a minimal NanoClaw with API channel + mock container
- Send a message via HTTP, verify response arrives

---

## Phase 4: Documentation

### 4.1 Update `.env.example`
Already covered in 1.2.

### 4.2 Add usage example to README or docs
**File:** `docs/api.md` or similar
- curl examples for health check and message sending
- SSE streaming example
- Error codes reference

---

## Checklist

- [x] 1.1 Config exports
- [x] 1.2 `.env.example` update
- [x] 2.1 `src/channels/api.ts` implementation
- [x] 2.2 Barrel file registration
- [x] 2.3 Self-registration call
- [x] 3.1 Unit tests
- [x] 3.2 Integration test (stretch) — skipped, unit tests cover HTTP round-trip
- [x] 4.1 `.env.example` (done with 1.2)
- [x] 4.2 API documentation
