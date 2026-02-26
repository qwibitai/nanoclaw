# Web Channel for NanoClaw (WebClaw Integration)
 
## Context
 
NanoClaw needs an HTTP API channel so that a separately-hosted webclaw frontend (TanStack Start app) can send messages and receive streamed agent responses. This is a new channel (`web`) alongside the existing WhatsApp, Slack, and GitHub channels. The webclaw fork will replace its `gateway.ts` with a simple HTTP/SSE client pointing at this API.
 
---
 
## Part 1: Hono.js Evaluation
 
### Pros
 
| Advantage | Detail |
|-----------|--------|
| **Tiny footprint** | ~14KB minified. NanoClaw is a lean single-process app — adding Express (2MB+ deps) or Fastify (1.5MB+) for one channel feels heavy |
| **TypeScript-first** | Native TS types, no `@types/*` needed. Matches nanoclaw's strict TS codebase |
| **Built-in SSE helper** | `hono/streaming` provides `streamSSE()` — first-class, no extra dependency |
| **Built-in middleware** | `cors`, `bearer-auth`, `logger` — all built-in, no plugin search |
| **Standards-based** | Uses Web Standard APIs (Request/Response). Future-proof if nanoclaw ever moves to Bun/Deno |
| **Simple API** | Express-like routing (`app.get`, `app.post`) — zero learning curve |
| **Node.js adapter** | `@hono/node-server` runs on native Node.js `http` module. Proven in production |
| **Zod integration** | `@hono/zod-validator` for request validation — nanoclaw already uses zod |
 
### Cons
 
| Disadvantage | Detail |
|-------------|--------|
| **Younger ecosystem** | ~3 years old vs Express (13yr) / Fastify (7yr). Fewer Stack Overflow answers |
| **Node.js is secondary** | Designed for edge runtimes (Cloudflare Workers). Node adapter works well but isn't the primary target |
| **SSE on Node.js** | `streamSSE()` works but needs care with connection cleanup on client disconnect. Need to handle `c.req.raw.signal` for abort detection |
| **No built-in WebSocket for Node** | WS support is edge-runtime only. Not an issue — we're using SSE, not WS |
| **Smaller community** | Fewer middleware/plugins than Express ecosystem. But we only need auth + cors + SSE |
 
### Alternatives Compared
 
| Framework | Size | SSE Support | TS Native | Node.js Fit | Verdict |
|-----------|------|-------------|-----------|-------------|---------|
| **Hono** | 14KB | Built-in `streamSSE()` | Yes | Good (adapter) | Best fit for minimal API |
| **Fastify** | 1.5MB | Plugin needed (`@fastify/sse`) | Good (with types) | Excellent (native) | Overkill for one channel |
| **Express** | 2MB+ | Manual implementation | No (needs @types) | Excellent | Too heavy, no SSE built-in |
| **Native http** | 0KB | Manual implementation | N/A | Perfect | Too verbose, reinventing wheels |
| **h3/unjs** | 50KB | Manual/helper | Yes | Good | Similar to Hono but less SSE support |
 
### Recommendation: **Hono**
 
Best fit for this use case: a minimal HTTP API (5 endpoints) with SSE streaming, running as one channel inside a larger Node.js process. The built-in SSE + auth + cors middleware means zero extra dependencies beyond `hono` and `@hono/node-server`. The zod validator integration is a bonus since nanoclaw already uses zod.
 
---
 
## Part 2: Web Channel Implementation Plan
 
### API Design
 
**Base URL:** `http://localhost:{WEB_API_PORT}` (default: 3100)
**Auth:** Bearer token via `Authorization: Bearer {WEB_AUTH_TOKEN}`
**JID scheme:** `{sessionId}@web` (e.g., `abc123@web`)
 
#### Endpoints
 
```
POST   /api/sessions                  Create a new web session
GET    /api/sessions                  List active sessions
GET    /api/sessions/:id/messages     Get message history for a session
POST   /api/sessions/:id/messages     Send a message to a session
GET    /api/sessions/:id/stream       SSE stream for real-time responses
```
 
#### Endpoint Details
 
**`POST /api/sessions`** — Create session
```json
// Request
{ "name": "Web Chat", "groupFolder": "main" }
 
// Response 201
{ "sessionId": "web-1740...", "jid": "web-1740...@web" }
```
Calls `onChatMetadata(jid, timestamp, name, 'web', false)` to register the chat.
 
**`GET /api/sessions`** — List sessions
```json
// Response 200
{ "sessions": [{ "id": "web-1740...", "jid": "web-1740...@web", "name": "Web Chat", "createdAt": "..." }] }
```
 
**`POST /api/sessions/:id/messages`** — Send message
```json
// Request
{ "content": "Hello @Andy, help me with...", "senderName": "User" }
 
// Response 202
{ "messageId": "msg-..." }
```
Calls `onMessage(jid, newMessage)` to deliver to the message loop. The message loop picks it up, checks trigger, enqueues to GroupQueue, spawns container.
 
**`GET /api/sessions/:id/messages`** — History
```json
// Query: ?since=ISO_TIMESTAMP&limit=50
// Response 200
{ "messages": [{ "id": "...", "sender_name": "...", "content": "...", "timestamp": "...", "is_bot_message": false }] }
```
Reads from SQLite `messages` table filtered by `chat_jid`.
 
**`GET /api/sessions/:id/stream`** — SSE stream
```
// SSE Events:
event: message
data: {"type":"text","content":"Here's my analysis...","messageId":"msg-..."}
 
event: typing
data: {"type":"typing","isTyping":true}
 
event: done
data: {"type":"done"}
 
event: error
data: {"type":"error","message":"Container timeout"}
```
 
### SSE Streaming Architecture
 
The key challenge: nanoclaw's existing flow calls `channel.sendMessage()` for each output chunk. For HTTP channels, we can't push to a client — we need SSE.
 
**Design: Per-session SSE emitter map**
 
```
WebChannel maintains:
  sseClients: Map<string, Set<WritableStreamDefaultWriter>>
 
On sendMessage(jid, text):
  1. Find all SSE clients connected to this jid
  2. Write SSE event to each client's stream
  3. Also store message in DB (like other channels)
 
On GET /api/sessions/:id/stream:
  1. Open SSE connection using Hono streamSSE()
  2. Add writer to sseClients map for this session's JID
  3. On client disconnect (AbortSignal), remove from map
 
On setTyping(jid, isTyping):
  1. Send "typing" SSE event to all connected clients for this JID
```
 
This maps perfectly to the existing Channel interface — `sendMessage()` pushes to SSE instead of calling an external API.
 
### Files to Create/Modify
 
| File | Action | Description |
|------|--------|-------------|
| `src/channels/web.ts` | **Create** | WebChannel class implementing Channel interface with Hono server |
| `src/index.ts` | **Modify** | Register WebChannel when `WEB_AUTH_TOKEN` is set in `.env` |
| `src/config.ts` | **Modify** | Add `WEB_API_PORT` (default 3100), `WEB_AUTH_TOKEN` |
| `package.json` | **Modify** | Add `hono`, `@hono/node-server`, `@hono/zod-validator` |
 
### Implementation: `src/channels/web.ts`
 
```typescript
class WebChannel implements Channel {
  name = 'web';
 
  // State
  private server: Server | null = null;
  private app: Hono;
  private sseClients = new Map<string, Set<SSEWriter>>();  // jid → connected clients
  private sessions = new Map<string, WebSession>();          // sessionId → metadata
 
  constructor(opts: WebChannelOpts) {
    this.app = new Hono();
    // Setup middleware: bearer auth, cors
    // Setup routes: sessions CRUD, messages, SSE stream
  }
 
  async connect() {
    // Start HTTP server on WEB_API_PORT using @hono/node-server serve()
  }
 
  async sendMessage(jid: string, text: string) {
    // Push SSE event to all clients connected to this JID
    // Prefix with "AssistantName: " to match other channels
  }
 
  ownsJid(jid: string) {
    return jid.endsWith('@web');
  }
 
  async setTyping(jid: string, isTyping: boolean) {
    // Push typing SSE event
  }
 
  async disconnect() {
    // Close all SSE connections, stop HTTP server
  }
}
```
 
### Authentication
 
- Bearer token: `WEB_AUTH_TOKEN` in `.env`
- Hono's built-in `bearerAuth` middleware
- Applied to all `/api/*` routes
- Webclaw's `gateway.ts` sends this token with every request
 
### Session & Group Management
 
Two modes:
1. **Simple mode (initial):** All web sessions route to the `main` group folder (like GitHub does). JID: `web-{timestamp}@web`
2. **Multi-group mode (future):** Web sessions can target specific registered groups via `groupFolder` param
 
For initial implementation, web sessions auto-register as groups pointing to `MAIN_GROUP_FOLDER`, similar to how GitHub auto-registers issues.
 
### Changes to `src/index.ts`
 
```typescript
// In main(), after other channels:
if (envTokens.WEB_AUTH_TOKEN) {
  const web = new WebChannel({
    ...channelOpts,
    authToken: envTokens.WEB_AUTH_TOKEN,
    port: Number(envTokens.WEB_API_PORT) || 3100,
    registerGroup,  // For auto-registering web sessions
  });
  channels.push(web);
  await web.connect();
}
```
 
### Changes to `src/config.ts`
 
Add to `.env` reading:
```
WEB_AUTH_TOKEN=    # Required to activate web channel
WEB_API_PORT=3100  # Optional, default 3100
```
 
### Webclaw Gateway Replacement (separate repo)
 
In the webclaw fork, `src/server/gateway.ts` becomes a thin HTTP client:
```typescript
// Replace WebSocket+ed25519 with:
const NANOCLAW_URL = process.env.NANOCLAW_API_URL;
const NANOCLAW_TOKEN = process.env.NANOCLAW_AUTH_TOKEN;
 
export async function sendMessage(sessionId, content, senderName) {
  return fetch(`${NANOCLAW_URL}/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${NANOCLAW_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, senderName }),
  });
}
 
export function streamResponses(sessionId) {
  return new EventSource(`${NANOCLAW_URL}/api/sessions/${sessionId}/stream`, {
    headers: { Authorization: `Bearer ${NANOCLAW_TOKEN}` }  // via eventsource polyfill
  });
}
```
 
---
 
## Verification Plan
 
1. **Unit test:** Send POST to `/api/sessions/:id/messages`, verify message appears in DB via `getNewMessages()`
2. **SSE test:** Connect to `/api/sessions/:id/stream`, send a message, verify SSE events arrive with agent response
3. **Integration test:** Start nanoclaw with `WEB_AUTH_TOKEN` set, use curl to:
   - Create session: `curl -X POST -H "Authorization: Bearer $TOKEN" localhost:3100/api/sessions`
   - Send message: `curl -X POST -H "Authorization: Bearer $TOKEN" -d '{"content":"@Andy hello","senderName":"Test"}' localhost:3100/api/sessions/{id}/messages`
   - Stream: `curl -N -H "Authorization: Bearer $TOKEN" localhost:3100/api/sessions/{id}/stream`
4. **Auth test:** Verify requests without valid token get 401
5. **Multi-client:** Open two SSE connections to same session, verify both receive events
6. **Disconnect handling:** Close SSE client, verify cleanup from `sseClients` map