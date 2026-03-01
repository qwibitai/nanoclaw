# Phase 2: Attachments - Research

**Researched:** 2026-03-01
**Domain:** Node.js file I/O, HTTP static server, base64 decoding, WebSocket protocol extension
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- El panel extiende el mensaje chat existente con un campo `attachments`: `{type:"chat", content, attachments:[{name, data, mime, size}]}`
- Campos por adjunto: `name` (nombre original), `data` (base64), `mime` (tipo MIME), `size` (bytes)
- Un mensaje con adjuntos puede tener `content` vacío — es válido enviar solo archivos sin texto
- Sin restricciones de MIME types ni tamaño máximo en v1
- El path relativo del archivo guardado se añade (append) al content del mensaje que recibe el agente
- El agente escribe archivos en `groups/better-work/files/` directamente; NanoClaw los sirve desde ahí
- El mensaje de respuesta sigue el mismo formato que el entrante, pero con `url` en lugar de `data`: `{type:"chat", content, attachments:[{name, url}]}`
- Sin limpieza automática de archivos en v1 (los archivos persisten indefinidamente)

### Claude's Discretion

- Formato exacto de la referencia al agente en el content
- Manejo de múltiples adjuntos en el content (una línea vs bloque)
- Naming de archivos en disco (nombre original + colisiones, o timestamp prefix)
- Mecanismo de detección de archivos salientes (scan de texto, watch de directorio, u otro)
- URL relativa (`/files/...`) vs absoluta (`http://localhost:3002/files/...`) en mensajes salientes
- CORS headers del servidor HTTP
- Política de arranque del servidor HTTP (siempre con WS, o bajo demanda)
- Comportamiento en conflicto de puerto (log + continuar, o error fatal)

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| ATT-01 | Adjuntos entrantes (`attachments[].data` en base64) se guardan en `groups/better-work/inbox/attachments/` y se añade referencia al content del mensaje | Node.js `fs.mkdirSync` + `Buffer.from(base64, 'base64')` + naming strategy — ver Architecture Patterns |
| ATT-02 | Un servidor HTTP estático sirve `groups/better-work/files/` en `WEBSOCKET_FILES_PORT` (default 3002) | `node:http` nativo con `fs.createReadStream` + mime lookup — ver Standard Stack |
| ATT-03 | Archivos salientes se copian a `groups/better-work/files/` y la URL `/files/...` se incluye en el mensaje `chat` con `attachments` | Scan regex del texto del agente + `sendMessage` override — ver Architecture Patterns |
| CONF-03 | `WEBSOCKET_FILES_PORT` (env var, default `3002`) configura el puerto del servidor HTTP estático | Extensión de `src/config.ts` con mismo patrón que `WEBSOCKET_PORT` |
</phase_requirements>

---

## Summary

Esta fase extiende `WebSocketChannel` con dos capacidades ortogonales: manejo de adjuntos entrantes (base64 → disco) y un servidor HTTP estático que expone los archivos generados por el agente. Ambas se pueden implementar completamente en Node.js con módulos nativos — sin nuevas dependencias npm.

El canal WS existente ya maneja el ciclo de vida de la conexión, buffering y heartbeat. Esta fase solo requiere: (1) modificar `handleInboundMessage` para procesar el campo `attachments`, (2) añadir un servidor `http.createServer` dentro de `WebSocketChannel` que sirva `groups/better-work/files/`, y (3) un mecanismo para detectar paths de archivo en las respuestas del agente y emitirlos como `attachments` en el mensaje saliente.

La detección de adjuntos salientes es el punto de mayor discreción. El enfoque recomendado es scan de texto: el agente incluye paths relativos en su respuesta (ej. `files/report.pdf`), `sendMessage` los detecta con regex y los convierte en `attachments[]` con URLs `/files/...`. Esto es zero-config para el agente y no requiere filesystem watchers.

**Primary recommendation:** Implementar todo dentro de `WebSocketChannel` usando `node:http`, `node:fs`, `node:path` y `node:crypto`. No se necesitan dependencias nuevas.

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `node:http` | Node.js 25 built-in | Servidor HTTP estático | Zero deps; `createServer` + `fs.createReadStream` es el patrón canónico para file serving |
| `node:fs` | Node.js 25 built-in | Guardar base64 a disco, leer archivos | `fs.mkdirSync({ recursive: true })` + `fs.writeFileSync` |
| `node:path` | Node.js 25 built-in | Resolución de paths, extensiones | `path.extname`, `path.join`, `path.resolve` |
| `node:crypto` | Node.js 25 built-in | Generación de IDs únicos para naming | `crypto.randomBytes(4).toString('hex')` como prefijo |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `node:stream` | Node.js 25 built-in | Pipe de `fs.createReadStream` → response | Más eficiente que `readFileSync` para archivos grandes |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `node:http` manual | `express` / `fastify` | Express añade ~200KB de deps para servir un directorio; `node:http` es suficiente para un endpoint estático simple |
| Naming con crypto prefix | `uuid` package | Ya existe `node:crypto`; `crypto.randomBytes(4).toString('hex')` da 8 chars hex suficientes para colisiones |
| Scan regex para archivos salientes | `fs.watch` sobre `files/` | Watch necesita lifecycle management y puede disparar en falsos positivos; scan en `sendMessage` es determinista |

**Installation:** No nuevas dependencias. Todo es Node.js built-in.

---

## Architecture Patterns

### Recommended Project Structure

```
src/
└── channels/
    └── websocket.ts    # Toda la lógica de attachments aquí (inline)

groups/better-work/
├── inbox/
│   └── attachments/    # Adjuntos entrantes (creado on-demand)
├── files/              # Archivos del agente (creado on-demand)
├── CLAUDE.md
└── logs/
```

### Pattern 1: Inbound Attachment Processing

**What:** Cuando llega un mensaje `{type:"chat", content, attachments:[{name, data, mime, size}]}`, decodificar cada adjunto de base64 y guardarlo en `inbox/attachments/`. Añadir referencia al `content` antes de pasar a `onMessage`.

**When to use:** En `handleInboundMessage`, rama `msg.type === 'chat'`.

```typescript
// Source: Node.js docs — fs.writeFileSync with Buffer
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

interface InboundAttachment {
  name: string;
  data: string;   // base64
  mime: string;
  size: number;
}

function saveInboundAttachment(
  groupDir: string,
  att: InboundAttachment,
): string {
  const inboxDir = path.join(groupDir, 'inbox', 'attachments');
  fs.mkdirSync(inboxDir, { recursive: true });

  // Naming: timestamp-prefix + original name to avoid collisions
  const prefix = `${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
  const safeName = path.basename(att.name).replace(/[^a-zA-Z0-9._-]/g, '_');
  const filename = `${prefix}-${safeName}`;
  const dest = path.join(inboxDir, filename);

  const buffer = Buffer.from(att.data, 'base64');
  fs.writeFileSync(dest, buffer);

  // Return relative path from groupDir for agent reference
  return path.join('inbox', 'attachments', filename);
}
```

**Agent content format (discretion recommendation):**
```
// Single attachment:
"<content>\n\n[Attachment: inbox/attachments/1234-ab-report.pdf]"

// Multiple attachments:
"<content>\n\n[Attachments:\n- inbox/attachments/1234-ab-report.pdf\n- inbox/attachments/1234-ab-photo.jpg]"
```

### Pattern 2: Static HTTP File Server

**What:** `http.createServer` que sirve `groups/better-work/files/` con path traversal protection y CORS.

**When to use:** Dentro de `WebSocketChannel`, arrancado junto con el WS server en `connect()`.

```typescript
// Source: Node.js docs — http.createServer
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

function startFileServer(filesDir: string, port: number): http.Server {
  const server = http.createServer((req, res) => {
    // Only serve GET requests under /files/
    if (!req.url?.startsWith('/files/')) {
      res.writeHead(404);
      res.end();
      return;
    }

    // Path traversal protection: resolve and verify it stays within filesDir
    const relativePath = req.url.slice('/files/'.length);
    const resolved = path.resolve(filesDir, relativePath);
    if (!resolved.startsWith(path.resolve(filesDir))) {
      res.writeHead(403);
      res.end();
      return;
    }

    if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
      res.writeHead(404);
      res.end();
      return;
    }

    // CORS: allow any origin (panel is same-machine localhost)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', getMimeType(path.extname(resolved)));

    fs.createReadStream(resolved).pipe(res);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.warn({ port }, 'Files port already in use, HTTP server not started');
    } else {
      logger.error({ err }, 'File server error');
    }
  });

  server.listen(port, '127.0.0.1');
  return server;
}

// Minimal MIME table — covers 95% of use cases
function getMimeType(ext: string): string {
  const map: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain',
    '.json': 'application/json',
    '.csv': 'text/csv',
    '.html': 'text/html',
    '.md': 'text/markdown',
    '.zip': 'application/zip',
    '.mp4': 'video/mp4',
    '.mp3': 'audio/mpeg',
  };
  return map[ext.toLowerCase()] ?? 'application/octet-stream';
}
```

### Pattern 3: Outbound Attachment Detection

**What:** Después de que el agente responde, antes de enviar via WS, escanear el texto buscando paths que existan en `files/`. Si se encuentran, incluirlos como `attachments[]` en el mensaje saliente.

**When to use:** En `sendMessage` del `WebSocketChannel`, transformar el payload antes de `ws.send()`.

**Recommended approach:** Regex scan — el agente escribe rutas como `files/report.pdf` o `/workspace/group/files/report.pdf` en su respuesta. Un regex simple las detecta:

```typescript
// Source: reasoning + Node.js fs.existsSync
const FILES_REF_REGEX = /(?:\/workspace\/group\/)?files\/([^\s\]"']+)/g;

function extractOutboundAttachments(
  text: string,
  filesDir: string,
  filesPort: number,
): { cleanText: string; attachments: Array<{ name: string; url: string }> } {
  const attachments: Array<{ name: string; url: string }> = [];
  const seen = new Set<string>();

  let match;
  while ((match = FILES_REF_REGEX.exec(text)) !== null) {
    const filename = match[1];
    if (seen.has(filename)) continue;
    seen.add(filename);

    const fullPath = path.join(filesDir, filename);
    if (fs.existsSync(fullPath)) {
      attachments.push({
        name: path.basename(filename),
        url: `/files/${filename}`,
      });
    }
  }

  return { cleanText: text, attachments };
}
```

**Note:** El texto NO se limpia — el agente puede mencionar el archivo en el texto y también aparece como adjunto. El panel decide si mostrar la mención textual o solo el attachment.

**Outbound message format (locked):**
```json
{
  "type": "chat",
  "content": "Aquí tienes el informe solicitado: files/report.pdf",
  "attachments": [
    { "name": "report.pdf", "url": "/files/report.pdf" }
  ]
}
```

### Pattern 4: Config Extension

**What:** Añadir `WEBSOCKET_FILES_PORT` a `src/config.ts` con el mismo patrón que `WEBSOCKET_PORT`.

```typescript
// Extensión de src/config.ts — mismo patrón que WEBSOCKET_PORT
export const WEBSOCKET_FILES_PORT = parseInt(
  process.env.WEBSOCKET_FILES_PORT || envConfig.WEBSOCKET_FILES_PORT || '3002',
  10,
);
```

Y añadir `'WEBSOCKET_FILES_PORT'` al array de `readEnvFile([...])`.

### Anti-Patterns to Avoid

- **No usar `fs.readFileSync` en el servidor HTTP:** Carga el archivo completo en memoria. Usar `fs.createReadStream(...).pipe(res)` siempre.
- **No omitir path traversal protection:** `path.resolve` + verificar que empieza con `path.resolve(filesDir)` es obligatorio. Un `..` en la URL podría exponer archivos del host.
- **No tirar error fatal si el puerto está en uso:** El servidor WS ya está funcionando. Loguear warn y continuar sin HTTP server es mejor que crashear NanoClaw.
- **No usar `fs.watch` para adjuntos salientes:** Race conditions, complejidad de lifecycle, y duplicados en plataformas macOS (doble evento). El scan en `sendMessage` es determinista.
- **No modificar la interfaz `Channel`:** `sendMessage(jid, text)` no cambia — la lógica de attachments es interna a `WebSocketChannel`. El resto del sistema no sabe nada de adjuntos.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| MIME type detection | Custom lookup con cientos de extensiones | Tabla inline con 15 tipos comunes + fallback `application/octet-stream` | 95% de los archivos que un agente genera son PDF, imagen, texto, CSV — no hace falta la spec completa |
| Path traversal protection | Regex custom | `path.resolve` + `startsWith` check | La forma canónica en Node.js; regex puede tener edge cases con `%2f`, encoding |
| Archivo serving | Leer en memoria y enviar | `fs.createReadStream().pipe(res)` | Backpressure automático; no explota con archivos grandes |
| Collision avoidance en naming | Custom hash o UUID | `Date.now() + crypto.randomBytes(2).toString('hex')` | 4 bytes = 4B combinaciones; timestamp garantiza ordenación cronológica |

**Key insight:** El servidor HTTP de esta fase es un file server de un solo endpoint. La complejidad es O(1) — no escala, no necesita routing sofisticado, no necesita middleware.

---

## Common Pitfalls

### Pitfall 1: Path Traversal en HTTP Server

**What goes wrong:** Una URL como `/files/../../../etc/passwd` podría servir archivos arbitrarios del sistema.
**Why it happens:** `path.join` solo concatena; no previene salidas del directorio base.
**How to avoid:** Después de `path.join(filesDir, relativePath)`, verificar `path.resolve(result).startsWith(path.resolve(filesDir))`. Rechazar con 403 si no cumple.
**Warning signs:** Tests con `..` en la URL no devuelven 403.

### Pitfall 2: Buffer de base64 inválido no tratado

**What goes wrong:** Si `att.data` está truncado o no es base64 válido, `Buffer.from(att.data, 'base64')` no lanza — crea un buffer parcial silenciosamente.
**Why it happens:** La API de Node.js no valida el input, simplemente decodifica lo que puede.
**How to avoid:** Verificar que `att.size` coincide con `buffer.length` después de decodificar. Si no coincide, loguear warn pero continuar (el archivo puede estar incompleto pero el mensaje no debe perderse).
**Warning signs:** Archivos guardados más pequeños de lo esperado.

### Pitfall 3: El servidor HTTP no arranca si el WS falla antes

**What goes wrong:** Si `connect()` lanza antes de llegar al `http.createServer`, el servidor de archivos nunca arranca.
**Why it happens:** `connect()` tiene `this.wss = new WebSocketServer(...)` como primera operación.
**How to avoid:** El servidor HTTP debe arrancar independientemente, antes o en paralelo al WS server. Ambos son independientes.

### Pitfall 4: `FILES_REF_REGEX` con estado global

**What goes wrong:** `RegExp` con flag `g` en JavaScript tiene estado (`lastIndex`). Si se reutiliza el mismo objeto regex entre llamadas, puede saltar matches.
**Why it happens:** Propiedad `lastIndex` se actualiza en cada `exec()`.
**How to avoid:** Crear la regex dentro de la función o resetear `lastIndex = 0` antes de usar. O usar `/regex/g` literal dentro del método (cada ejecución crea nueva instancia).
**Warning signs:** Detección de adjuntos aleatoriamente inconsistente.

### Pitfall 5: `files/` directory no existe cuando el agente escribe

**What goes wrong:** Si el agente escribe en `/workspace/group/files/` antes de que NanoClaw cree el directorio, el agente recibe un error de escritura.
**Why it happens:** El directorio `groups/better-work/files/` no se crea automáticamente.
**How to avoid:** En `connect()` o en `ensureBetterWorkGroup()`, crear `groups/better-work/files/` y `groups/better-work/inbox/attachments/` con `fs.mkdirSync({ recursive: true })`.

---

## Code Examples

### Complete sendMessage con outbound attachments

```typescript
// WebSocketChannel.sendMessage — extensión para adjuntos salientes
async sendMessage(_jid: string, text: string): Promise<void> {
  const { attachments } = this.extractOutboundAttachments(text);

  const payload: Record<string, unknown> = { type: 'chat', content: text };
  if (attachments.length > 0) {
    payload.attachments = attachments;
  }

  const serialized = JSON.stringify(payload);

  if (this.isConnected()) {
    this.client!.send(serialized);
  } else {
    this.bufferMessage(text);  // Buffer sigue usando solo text — los attachments se re-detectan al flush
  }
}
```

### Handling inbound chat message con attachments

```typescript
// En handleInboundMessage, rama type === 'chat'
if (msg.type === 'chat') {
  let content = msg.content ?? '';  // content puede ser vacío si solo hay attachments

  if (Array.isArray(msg.attachments) && msg.attachments.length > 0) {
    const refs: string[] = [];
    for (const att of msg.attachments as InboundAttachment[]) {
      try {
        const relPath = this.saveInboundAttachment(att);
        refs.push(relPath);
      } catch (err) {
        logger.warn({ err, name: att.name }, 'Failed to save attachment');
      }
    }
    if (refs.length > 0) {
      const refBlock = refs.length === 1
        ? `\n\n[Attachment: ${refs[0]}]`
        : `\n\n[Attachments:\n${refs.map(r => `- ${r}`).join('\n')}]`;
      content = content + refBlock;
    }
  }

  // content puede ser solo la referencia si el mensaje no tenía texto
  const newMsg: NewMessage = {
    id: crypto.randomUUID(),
    chat_jid: WS_JID,
    sender: 'ws:user',
    sender_name: 'User',
    content,
    timestamp: new Date().toISOString(),
  };
  this.opts.onMessage(WS_JID, newMsg);
}
```

### disconnect() con HTTP server cleanup

```typescript
async disconnect(): Promise<void> {
  // Limpiar heartbeat/pong (ya existente)
  if (this.heartbeatInterval) { clearInterval(this.heartbeatInterval); this.heartbeatInterval = null; }
  if (this.pongTimeout) { clearTimeout(this.pongTimeout); this.pongTimeout = null; }

  // Cerrar HTTP server
  if (this.fileServer) {
    this.fileServer.close();
    this.fileServer = null;
  }

  if (this.wss) { this.wss.close(); this.wss = null; }
  this.client = null;
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `express.static` para file serving | `http.createServer` + `fs.createReadStream` | Node.js 18+ con suficiente madurez | Sin deps extra para un endpoint simple |
| `uuid` package para IDs | `node:crypto.randomUUID()` / `randomBytes` | Node.js 14.17+ | Built-in; crypto ya importado en `websocket.ts` |

**Deprecated/outdated:**

- `fs.readFile` en callback style: usar `fs.writeFileSync`/`fs.readFileSync` o las variantes `fs/promises` (en este contexto sync es aceptable ya que el servidor de archivos no es crítico para latencia).

---

## Open Questions

1. **Buffer behaviour con attachments**
   - What we know: El buffer actual almacena `content: string`. Si un mensaje tiene adjuntos y se bufferiza, los attachments no se bufferizarán (el archivo existe en disco pero el mensaje saliente recalculará los refs al hacer flush).
   - What's unclear: ¿Debe el buffer preservar los attachments detectados, o re-detectarlos al hacer flush?
   - Recommendation: Re-detectar al flush. Los archivos persisten en disco, así que la re-detección funcionará. Implementar el re-scan en `flushBuffer` es más simple.

2. **`files/` del agente vs. paths del contenedor**
   - What we know: El agente corre dentro de un contenedor donde ve `/workspace/group/files/`. El host ve `groups/better-work/files/`. El regex debe mapear `/workspace/group/files/` → `groups/better-work/files/`.
   - What's unclear: ¿El agente menciona el path del contenedor o el path relativo?
   - Recommendation: El regex debe aceptar ambos: `/workspace/group/files/<name>` y `files/<name>`. Normalizar a `files/<name>` para la URL.

---

## Sources

### Primary (HIGH confidence)

- Node.js 25 docs (built-in knowledge) — `http.createServer`, `fs.createReadStream`, `path.resolve`, `Buffer.from(base64)`, `crypto.randomBytes`
- `src/channels/websocket.ts` — implementación existente Phase 1 (leída directamente)
- `src/config.ts` — patrón de configuración existente (leído directamente)
- `src/types.ts` — interfaces `Channel`, `NewMessage` (leído directamente)

### Secondary (MEDIUM confidence)

- Node.js path traversal protection pattern — ampliamente documentado en Node.js security guides; patrón `path.resolve + startsWith` es el canónico
- MIME type table — tipos cubiertos verificados contra RFC estándar

### Tertiary (LOW confidence)

- Comportamiento exacto del agente al escribir archivos en `/workspace/group/files/` — depende del container mount y del CLAUDE.md del grupo. A verificar al implementar ATT-03.

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — todo es Node.js built-in, sin dependencias externas
- Architecture: HIGH — patrones directamente derivados del código existente de Phase 1
- Pitfalls: HIGH — path traversal y RegExp stateful son pitfalls conocidos y verificados en Node.js docs

**Research date:** 2026-03-01
**Valid until:** 2026-04-01 (Node.js built-ins son estables; no hay riesgo de cambio de API)
