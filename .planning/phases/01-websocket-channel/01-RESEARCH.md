# Phase 1: WebSocket Channel - Research

**Researched:** 2026-03-01
**Domain:** Node.js WebSocket server (ws library) + Channel abstraction integration
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Buffer de desconexión (PROTO-05)**
- Tamaño máximo: 50 mensajes
- Política de overflow: drop oldest (descarta el más antiguo al llenarse)
- Entrega al reconectar: con indicador — primero `{type:"system", event:"buffered_start", count:N}`, luego los mensajes buffereados, luego `{type:"system", event:"buffered_end"}`
- Los mensajes buffereados llevan su timestamp original para que el panel pueda identificarlos como mensajes diferidos

**Feedback de errores al cliente**
- El protocolo incluye un tipo de mensaje explícito: `{type:"error", code:"...", message:"..."}`
- Situaciones que generan error al cliente: errores críticos del agente/servidor + timeouts de respuesta
- Timeout de respuesta del agente: 60 segundos
- Tras enviar un error, el canal sigue activo — el cliente puede continuar enviando mensajes

**Señales de estado del canal**
- Al conectar: el servidor envía `{type:"system", event:"connected", payload:{buffered_count:N}}` para confirmar conexión lista e indicar cuántos mensajes buffereados llegan
- Al desconectar el cliente: el servidor envía `[SYSTEM] client_disconnected` al agente para que sepa que no hay cliente escuchando
- Heartbeat: ping cada 30 segundos; si no hay pong en 10 segundos, la conexión se considera zombie y se limpia
- No hay evento de "inicio de procesamiento" separado — el typing indicator (PROTO-04) cubre esa señal

**CLAUDE.md inicial del grupo better-work (INTG-03)**
- Rol: asistente de productividad personal
- Idioma de respuesta: siempre español, sin excepciones en respuestas al usuario
- Capacidades multilingüe: puede leer y escribir en catalán e inglés cuando el usuario lo pida explícitamente (emails, documentos); nunca lo hace de forma espontánea
- Herramientas al arrancar: acceso básico al filesystem del grupo (`groups/better-work/`)
- Tono: directo y conciso, sin relleno ni frases de cortesía

### Claude's Discretion

No hay áreas marcadas como discretion explícita en CONTEXT.md.

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope.

**Out of scope per REQUIREMENTS.md:**
- Panel web Next.js
- Autenticación WS
- Multi-cliente simultáneo
- Adjuntos (ATT-01, ATT-02, ATT-03 son Phase 2)
- WEBSOCKET_FILES_PORT / HTTP estático (CONF-03 es Phase 2)
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| CHAN-01 | El canal WS implementa la interfaz `Channel` de `src/types.ts` | La interfaz Channel ya existe: `connect()`, `sendMessage()`, `isConnected()`, `ownsJid()`, `disconnect()`, `setTyping?()` |
| CHAN-02 | `connect()` levanta el servidor WS en el puerto configurado (`WEBSOCKET_PORT`, default 3001) | `WebSocketServer({ port })` de la librería `ws` — ya instalada (v8.19.0) |
| CHAN-03 | `ownsJid(jid)` retorna `true` para JIDs con prefijo `ws:` | Patrón idéntico a WhatsApp (`@g.us`) y Telegram (`tg:`); el JID del canal WS será `ws:better-work` |
| CHAN-04 | `isConnected()` retorna `true` cuando hay al menos un cliente WS conectado | Se mantiene referencia al WebSocket del cliente activo; `isConnected()` comprueba `this.client !== null` |
| CHAN-05 | Si el cliente se desconecta y reconecta, el servidor sigue funcionando sin reiniciar NanoClaw | El servidor `WebSocketServer` persiste; solo la referencia al cliente cambia en el evento `connection` |
| CHAN-06 | `disconnect()` cierra el servidor WS limpiamente | `wss.close(callback)` + `clearInterval(heartbeatInterval)` |
| PROTO-01 | Mensajes `{type:"chat", content:string}` → `NewMessage` → `opts.onMessage()` | JSON.parse del mensaje WS entrante; construir `NewMessage` con `id: crypto.randomUUID()` |
| PROTO-02 | Mensajes `{type:"system", action:string, payload:object}` → `NewMessage` con `[SYSTEM] action: payload_json` | Mismo mecanismo que PROTO-01; content formateado como `[SYSTEM] {action}: {JSON.stringify(payload)}` |
| PROTO-03 | `sendMessage(jid, text)` envía `{type:"chat", content:text}` al cliente WS | `this.client.send(JSON.stringify({type:"chat", content:text}))` cuando cliente conectado; buffer si no |
| PROTO-04 | `setTyping(jid, isTyping)` envía `{type:"system", event:"typing", payload:{isTyping}}` | `this.client?.send(JSON.stringify({type:"system", event:"typing", payload:{isTyping}}))` |
| PROTO-05 | Buffer de 50 mensajes; entrega al reconectar con `buffered_start/buffered_end` | Array circular con drop-oldest; flush on `connection` event |
| CONF-01 | `WEBSOCKET_ENABLED` (env var, default `true`) controla el registro del canal | Seguir patrón de `readEnvFile()` en `src/env.ts` + `src/config.ts` |
| CONF-02 | `WEBSOCKET_PORT` (env var, default `3001`) configura el puerto | Idem — añadir a `config.ts` |
| INTG-01 | El canal WS se registra en `src/index.ts` `main()` condicionado a `WEBSOCKET_ENABLED` | Mismo patrón que `TELEGRAM_BOT_TOKEN` — if condicional en `main()` |
| INTG-02 | El grupo `better-work` se auto-registra en la DB al arrancar si no existe, con `requiresTrigger: false` | Llamar `setRegisteredGroup()` + `registerGroup()` dentro de `main()` antes del message loop |
| INTG-03 | La estructura `groups/better-work/` se crea con `CLAUDE.md` inicial | `fs.mkdirSync()` + `fs.writeFileSync()` solo si el archivo no existe |
</phase_requirements>

## Summary

La fase 1 implementa un canal WebSocket en NanoClaw siguiendo el mismo patrón arquitectónico que ya usan los canales WhatsApp y Telegram. El proyecto tiene una abstracción `Channel` bien definida en `src/types.ts` — el nuevo `WebSocketChannel` debe implementarla sin modificar la interfaz existente.

La librería `ws` (v8.19.0) ya está instalada como dependencia transitiva de `@whiskeysockets/baileys`. No requiere nueva instalación. Sin embargo, como dependencia transitiva, hay que añadirla como dependencia directa en `package.json` para que no desaparezca en una actualización de Baileys. `@types/ws` no está instalado y debe añadirse como devDependency.

El proyecto usa ESM (`"type": "module"`, `"module": "NodeNext"`) y `vitest` como framework de test. Los tests del canal WhatsApp muestran el patrón exacto a seguir: mocks de `vi.mock()`, instancias de `EventEmitter` como fakes, y tests de comportamiento de alto nivel.

**Primary recommendation:** Crear `src/channels/websocket.ts` modelado sobre `src/channels/whatsapp.ts`, añadir `ws` y `@types/ws` como dependencias directas, y registrar el canal en `main()` con el mismo patrón condicional que Telegram.

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| ws | 8.19.0 (ya instalada) | Servidor WebSocket Node.js | Ya en el proyecto como transitiva; la más usada en Node.js, sin deps, probada en Autobahn suite |
| @types/ws | latest (~8.5.x) | Tipos TypeScript para ws | Requerido para compilar con `strict: true` |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| node:crypto | built-in | `randomUUID()` para IDs de mensaje | Generar IDs únicos para `NewMessage` del canal WS |
| node:fs | built-in | Crear directorios y `CLAUDE.md` inicial | INTG-03: provisión del grupo `better-work` |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| ws | socket.io | socket.io añade protocolo propio, reconexión automática, rooms — demasiado para un único cliente; el panel web controla la reconexión |
| ws | uWebSockets.js | Más rápido pero C++ nativo, no puro Node.js; no justificado para un único cliente |

**Installation:**
```bash
pnpm add ws
pnpm add -D @types/ws
```

## Architecture Patterns

### Recommended Project Structure

```
src/
├── channels/
│   ├── whatsapp.ts          # Referencia — patrón a seguir
│   ├── telegram.ts          # Referencia — patrón a seguir
│   └── websocket.ts         # NUEVO — implementar aquí
├── config.ts                # Añadir WEBSOCKET_ENABLED, WEBSOCKET_PORT
└── index.ts                 # Añadir registro del canal + auto-provisión better-work
groups/
└── better-work/             # Creado por INTG-03 al arrancar
    ├── logs/
    └── CLAUDE.md
```

### Pattern 1: Estructura del WebSocketChannel

**What:** Clase que implementa la interfaz `Channel` con servidor WS persistente y referencia mutable al cliente activo.

**When to use:** Siempre — es la única forma de integrar WS en el sistema de canales.

**Example:**
```typescript
// Source: src/channels/whatsapp.ts (patrón existente) + ws README
import { WebSocketServer, WebSocket } from 'ws';
import type { Channel, NewMessage, OnInboundMessage, OnChatMetadata } from '../types.js';

const WS_JID = 'ws:better-work'; // JID fijo para el único grupo WS

export interface WebSocketChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
}

export class WebSocketChannel implements Channel {
  name = 'websocket';

  private wss: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  private buffer: Array<{ content: string; timestamp: string }> = [];
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private pongTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly port: number, private readonly opts: WebSocketChannelOpts) {}

  async connect(): Promise<void> { /* ... */ }
  sendMessage(jid: string, text: string): Promise<void> { /* buffer o send */ }
  isConnected(): boolean { return this.client !== null && this.client.readyState === WebSocket.OPEN; }
  ownsJid(jid: string): boolean { return jid.startsWith('ws:'); }
  async disconnect(): Promise<void> { /* close server + clear intervals */ }
  async setTyping(jid: string, isTyping: boolean): Promise<void> { /* send typing event */ }
}
```

### Pattern 2: Heartbeat nativo del protocolo WS

**What:** Ping/pong usando el mecanismo nativo WS (no mensajes de aplicación). El servidor hace ping cada 30 segundos. Si no hay pong en 10 segundos, la conexión se termina.

**When to use:** En la conexión de cada cliente nuevo. Se limpia al desconectar.

**Example:**
```typescript
// Source: ws README — "How to detect and close broken connections?"
wss.on('connection', (ws) => {
  // Nuevo cliente — reemplazar el anterior si existía
  if (this.client) {
    this.client.terminate();  // Limpiar zombie anterior
  }
  this.client = ws;
  let isAlive = true;

  ws.on('pong', () => { isAlive = true; });

  this.heartbeatInterval = setInterval(() => {
    if (!isAlive) {
      ws.terminate();
      this.client = null;
      return;
    }
    isAlive = false;
    ws.ping();
    // Timeout de 10s para el pong (decidido en CONTEXT.md)
    this.pongTimeout = setTimeout(() => {
      if (!isAlive) ws.terminate();
    }, 10_000);
  }, 30_000);

  ws.on('close', () => {
    clearInterval(this.heartbeatInterval!);
    clearTimeout(this.pongTimeout!);
    this.client = null;
    // Notificar al agente (CONTEXT.md: "[SYSTEM] client_disconnected")
    this.opts.onMessage(WS_JID, buildSystemMessage('client_disconnected', {}));
  });
});
```

### Pattern 3: Buffer con drop-oldest

**What:** Array de máximo 50 elementos. Al llenarse, se elimina el más antiguo antes de añadir el nuevo. Se vacía al reconectar con señales `buffered_start/buffered_end`.

**When to use:** En `sendMessage()` cuando `this.client === null` o no está OPEN.

**Example:**
```typescript
// Source: decisiones de CONTEXT.md
const MAX_BUFFER = 50;

private bufferMessage(content: string): void {
  if (this.buffer.length >= MAX_BUFFER) {
    this.buffer.shift(); // drop oldest
  }
  this.buffer.push({ content, timestamp: new Date().toISOString() });
}

private flushBuffer(ws: WebSocket): void {
  if (this.buffer.length === 0) return;
  const count = this.buffer.length;
  ws.send(JSON.stringify({ type: 'system', event: 'buffered_start', count }));
  for (const msg of this.buffer) {
    ws.send(JSON.stringify({ type: 'chat', content: msg.content, timestamp: msg.timestamp }));
  }
  ws.send(JSON.stringify({ type: 'system', event: 'buffered_end' }));
  this.buffer = [];
}
```

### Pattern 4: Auto-provisión del grupo better-work

**What:** En `main()`, antes del message loop, verificar si el grupo `better-work` existe en DB y en disco. Si no, crearlo.

**When to use:** Siempre en startup cuando `WEBSOCKET_ENABLED` es true.

**Example:**
```typescript
// Source: patrón de registerGroup() en src/index.ts
function ensureBetterWorkGroup(): void {
  const jid = WS_JID; // 'ws:better-work'
  const existing = registeredGroups[jid];
  if (existing) return;

  registerGroup(jid, {
    name: 'better-work',
    folder: 'better-work',
    trigger: '@Nano',
    added_at: new Date().toISOString(),
    requiresTrigger: false,
  });

  // CLAUDE.md inicial solo si no existe
  const groupDir = resolveGroupFolderPath('better-work');
  const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) {
    fs.writeFileSync(claudeMdPath, BETTER_WORK_CLAUDE_MD);
  }
}
```

### Pattern 5: Protocolo de mensajes entrantes

**What:** Parsear JSON del mensaje WS y convertirlo a `NewMessage` para el bus interno.

**Example:**
```typescript
// Source: REQUIREMENTS.md PROTO-01, PROTO-02
ws.on('message', (raw) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString());
  } catch {
    ws.send(JSON.stringify({ type: 'error', code: 'PARSE_ERROR', message: 'Invalid JSON' }));
    return;
  }

  const msg = parsed as { type: string; content?: string; action?: string; payload?: unknown };

  if (msg.type === 'chat' && typeof msg.content === 'string') {
    this.opts.onMessage(WS_JID, {
      id: crypto.randomUUID(),
      chat_jid: WS_JID,
      sender: 'ws:user',
      sender_name: 'User',
      content: msg.content,
      timestamp: new Date().toISOString(),
    });
  } else if (msg.type === 'system') {
    const payloadStr = JSON.stringify(msg.payload ?? {});
    this.opts.onMessage(WS_JID, {
      id: crypto.randomUUID(),
      chat_jid: WS_JID,
      sender: 'ws:user',
      sender_name: 'User',
      content: `[SYSTEM] ${msg.action}: ${payloadStr}`,
      timestamp: new Date().toISOString(),
    });
  }
});
```

### Anti-Patterns to Avoid

- **No usar `socket.io`:** Añade protocolo propio incompatible con clientes WebSocket nativos del navegador que no usen socket.io-client.
- **No reiniciar el servidor en cada desconexión:** El servidor `WebSocketServer` es persistente. Solo la referencia `this.client` cambia.
- **No usar `ws.close()` para zombies:** Usar `ws.terminate()` — `close()` espera el handshake de cierre que nunca llega en conexiones zombie.
- **No hacer ping con mensajes de aplicación:** Usar `ws.ping()` nativo — el spec WS define ping/pong en protocolo; browsers responden automáticamente.
- **No lanzar errores en `sendMessage()` cuando no hay cliente:** Silenciosamente bufferear — el canal sigue activo.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Detección de conexiones zombie | Timer manual con timeouts de aplicación | `ws.ping()` nativo + `pong` event | El protocolo WS define ping/pong — browsers responden automáticamente; los timers de aplicación son redundantes |
| Serialización/deserialización de mensajes | Parser custom | `JSON.parse/stringify` directo | El protocolo es simple; no hay schema complejo |
| Gestión del upgrade HTTP→WS | Server HTTP propio con manejo manual del upgrade | `WebSocketServer({ port })` | `ws` crea y gestiona el servidor HTTP interno automáticamente |

**Key insight:** La librería `ws` maneja toda la complejidad del protocolo WebSocket. El código de la fase es principalmente lógica de negocio (buffer, routing, protocolo de mensajes).

## Common Pitfalls

### Pitfall 1: `ws` como dependencia transitiva puede desaparecer

**What goes wrong:** `ws` está instalada porque `@whiskeysockets/baileys` la necesita. Si Baileys deja de depender de `ws` en una actualización futura, desaparece del proyecto.

**Why it happens:** pnpm solo garantiza que las dependencias directas estén disponibles de forma estable.

**How to avoid:** Añadir `ws` y `@types/ws` como dependencias directas en `package.json`.

**Warning signs:** `Cannot find module 'ws'` tras actualizar Baileys.

### Pitfall 2: TypeScript — módulo ESM con imports de `ws`

**What goes wrong:** Con `"module": "NodeNext"`, el import de `ws` debe incluir extensión o ser compatible con el resolver. `ws` exporta CJS pero tiene un wrapper ESM (`wrapper.mjs`).

**Why it happens:** `"moduleResolution": "NodeNext"` es estricto con los exports de los paquetes.

**How to avoid:** Usar `import { WebSocketServer, WebSocket } from 'ws';` — el wrapper ESM de ws v8 lo expone correctamente.

**Warning signs:** Error de tipo `Module '"ws"' has no exported member 'WebSocketServer'` — indica que TypeScript no encuentra `@types/ws`.

### Pitfall 3: Race condition en handshake de conexión y flush del buffer

**What goes wrong:** Se envía el flush del buffer antes de que el cliente esté en estado `OPEN` completo.

**Why it happens:** El evento `connection` se emite cuando el WebSocket está listo, pero enviar en el mismo tick puede fallar si el handshake aún no está completamente establecido del lado del cliente.

**How to avoid:** El evento `connection` de `WebSocketServer` garantiza que `ws.readyState === WebSocket.OPEN`. Se puede enviar directamente. Sin embargo, mandar `connected` + flush en el mismo handler del event `connection` es seguro porque `ws` ya lo marca como OPEN en ese momento.

**Warning signs:** `Error: WebSocket is not open: readyState 0 (CONNECTING)`.

### Pitfall 4: Múltiples clientes — comportamiento no definido en v1

**What goes wrong:** Si dos pestañas del panel conectan simultáneamente, el segundo cliente reemplaza al primero sin notificación explícita.

**Why it happens:** La spec dice single-client en v1.

**How to avoid:** Cuando llega un nuevo `connection` event y `this.client` ya existe, llamar `this.client.terminate()` primero, luego asignar el nuevo. Opcionalmente enviar `{type:"error", code:"REPLACED", message:"Nueva conexión establecida"}` al cliente desplazado — aunque ya estará terminado.

**Warning signs:** Dos clientes conectados simultáneamente; el primero deja de recibir mensajes silenciosamente.

### Pitfall 5: `onMessage` en `channelOpts` de `index.ts` llama a `storeMessage`

**What goes wrong:** El callback `onMessage` en `main()` hace `storeMessage(msg)` — eso requiere que la `chat_jid` del mensaje esté registrada en la tabla `chats` para que la FK no falle.

**Why it happens:** `storeChatMetadata` debe llamarse antes o conjuntamente con `storeMessage`. El canal WhatsApp llama `onChatMetadata` antes de `onMessage`.

**How to avoid:** El `WebSocketChannel` debe llamar `opts.onChatMetadata(WS_JID, timestamp, 'better-work', 'websocket', false)` en el primer mensaje o en `connect()` para registrar la entrada en `chats`.

**Warning signs:** `FOREIGN KEY constraint failed` en SQLite al recibir el primer mensaje WS.

## Code Examples

Verified patterns from official sources:

### Servidor WS simple con manejo de conexión/desconexión

```typescript
// Source: ws README v8.19.0 — "Simple server" + "detect and close broken connections"
import { WebSocketServer, WebSocket } from 'ws';

const wss = new WebSocketServer({ port: 3001 });

wss.on('connection', (ws) => {
  ws.on('error', (err) => logger.error({ err }, 'WS client error'));
  ws.on('message', (data) => {
    const text = data.toString();
    // handle message...
  });
  ws.send(JSON.stringify({ type: 'system', event: 'connected', payload: { buffered_count: 0 } }));
});
```

### Heartbeat con ping/pong nativo

```typescript
// Source: ws README v8.19.0 — "How to detect and close broken connections?"
// Ping cada 30s; timeout de pong a 10s (CONTEXT.md decisions)
let isAlive = true;
ws.on('pong', () => { isAlive = true; });

const heartbeat = setInterval(() => {
  if (!isAlive) {
    ws.terminate();
    clearInterval(heartbeat);
    return;
  }
  isAlive = false;
  ws.ping();
}, 30_000);

ws.on('close', () => clearInterval(heartbeat));
```

### Cierre limpio del servidor

```typescript
// Source: ws README v8.19.0
wss.close((err) => {
  if (err) logger.error({ err }, 'Error closing WS server');
  else logger.info('WS server closed');
});
```

### Patrón de JID para el canal WS

```typescript
// Source: src/channels/whatsapp.ts + src/channels/telegram.ts (patrón observado)
// WhatsApp usa @g.us, Telegram usa tg:, WS usará ws:
ownsJid(jid: string): boolean {
  return jid.startsWith('ws:');
}
// JID del grupo better-work: 'ws:better-work'
```

### Integración en config.ts (patrón existente)

```typescript
// Source: src/config.ts — patrón readEnvFile existente
const envConfig = readEnvFile([
  // ... otros
  'WEBSOCKET_ENABLED',
  'WEBSOCKET_PORT',
]);

export const WEBSOCKET_ENABLED =
  (process.env.WEBSOCKET_ENABLED ?? envConfig.WEBSOCKET_ENABLED ?? 'true') !== 'false';
export const WEBSOCKET_PORT = parseInt(
  process.env.WEBSOCKET_PORT || envConfig.WEBSOCKET_PORT || '3001',
  10,
);
```

### Integración en index.ts (patrón Telegram)

```typescript
// Source: src/index.ts — patrón if (TELEGRAM_BOT_TOKEN) existente
if (WEBSOCKET_ENABLED) {
  const wsChannel = new WebSocketChannel(WEBSOCKET_PORT, channelOpts);
  channels.push(wsChannel);
  await wsChannel.connect();
  ensureBetterWorkGroup(); // INTG-02, INTG-03
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| socket.io (con protocolo propio) | ws bare WebSocket + JSON custom protocol | ~2018+ | Más interoperable con clientes nativos del navegador |
| Ping/pong con mensajes de aplicación | `ws.ping()` nativo del protocolo | Siempre fue parte del spec RFC 6455 | Browsers responden automáticamente |
| `ws@7.x` sin wrapper ESM | `ws@8.x` con `wrapper.mjs` para ESM | ws v8.0.0 (2022) | Imports ESM funcionan directamente |

**Deprecated/outdated:**
- `ws.OPEN` como constante numérica: seguir usando `WebSocket.OPEN` (estático en la clase) — más legible.
- `verifyClient` deprecado en favor de `handleProtocols` para auth — no relevante en v1 (sin auth).

## Open Questions

1. **¿`onChatMetadata` debe usar `isGroup: false` para el canal WS?**
   - What we know: El canal WS es un solo cliente conectado directamente, no un grupo de chat real. La DB tiene columna `is_group`.
   - What's unclear: Si `is_group: false` afecta a alguna lógica de `getAvailableGroups()` o el message loop.
   - Recommendation: Usar `isGroup: false` (es un canal de 1:1 virtual) y verificar que `getAvailableGroups()` no filtra por `is_group` — mirando el código, filtra por `c.is_group` siendo true, así que el canal WS no aparecería en la lista de grupos disponibles para el agente main. Esto es correcto.

2. **¿Dónde colocar `ensureBetterWorkGroup()` — en `connect()` o en `main()`?**
   - What we know: La función `registerGroup()` en `index.ts` modifica `registeredGroups` (variable de módulo) y llama `setRegisteredGroup()` en DB.
   - What's unclear: Si llamarlo desde `WebSocketChannel.connect()` crea un acoplamiento indeseado entre el canal y la lógica de provisión de grupos.
   - Recommendation: Mantenerlo en `main()` de `index.ts` — el canal no debería conocer los grupos. `connect()` solo levanta el servidor.

## Validation Architecture

> `workflow.nyquist_validation` no está en `.planning/config.json` — omitiendo sección.

## Sources

### Primary (HIGH confidence)

- `node_modules/ws/README.md` (v8.19.0) — heartbeat pattern, server API, ping/pong nativo
- `node_modules/ws/wrapper.mjs` — exports ESM verificados: `WebSocket`, `WebSocketServer`
- `node_modules/ws/lib/websocket-server.js` — opciones del constructor, eventos, `autoPong: true` por defecto
- `src/types.ts` — interfaz `Channel` exacta que debe implementarse
- `src/channels/whatsapp.ts` — patrón de implementación de canal a seguir
- `src/index.ts` — integración de canales en `main()`, `channelOpts`, `registerGroup()`
- `src/config.ts` — patrón de lectura de env vars
- `src/db.ts` — `setRegisteredGroup()`, `storeChatMetadata()`, `storeMessage()`

### Secondary (MEDIUM confidence)

- `package.json` — confirma `vitest@^4.0.18`, pnpm como package manager, `"type": "module"`
- `tsconfig.json` — confirma `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`, `"strict": true`
- `src/channels/whatsapp.test.ts` — patrón de test para canales (mocks, EventEmitter fakes)

### Tertiary (LOW confidence)

- Ninguna — toda la información viene de fuentes primarias del proyecto y de la librería instalada.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — `ws` ya instalada, versión verificada, exports ESM verificados
- Architecture: HIGH — patrón de canal existente documentado, interfaz `Channel` exacta conocida
- Pitfalls: HIGH — identificados leyendo el código fuente real del proyecto y la librería

**Research date:** 2026-03-01
**Valid until:** 2026-04-01 (ws es librería estable; el proyecto no cambia de arquitectura frecuentemente)
