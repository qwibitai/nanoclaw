# NanoClaw — Better Copilot

## What This Is

NanoClaw es un asistente personal (Claude) que actualmente se comunica vía WhatsApp y Telegram. Este milestone añade un canal WebSocket para conectar NanoClaw con un panel web (Next.js) dedicado al contexto laboral de Daniel en Better Consultants, permitiendo comunicación bidireccional sin depender de aplicaciones de mensajería.

## Core Value

El agente de trabajo responde al panel web en tiempo real, con soporte para mensajes estructurados (system actions) y adjuntos, siguiendo el mismo patrón de canal que Telegram y WhatsApp.

## Requirements

### Validated

<!-- Capacidades existentes del codebase NanoClaw -->

- ✓ Canal WhatsApp (WhatsApp Web via Baileys) — existing
- ✓ Canal Telegram (Grammy bot framework) — existing
- ✓ Interfaz `Channel` polimórfica en `src/types.ts` — existing
- ✓ Orquestador multi-canal en `src/index.ts` — existing
- ✓ Runner de contenedores Docker con aislamiento por grupo — existing
- ✓ Registro de grupos vía DB + IPC — existing
- ✓ Schedulers de tareas con cron/interval/once — existing
- ✓ SQLite para persistencia de mensajes, sesiones, grupos, tareas — existing

<!-- v1.0 WebSocket Channel — shipped 2026-03-02 -->

- ✓ Canal WebSocket implementa interfaz `Channel` (`src/channels/websocket.ts`) — v1.0
- ✓ Servidor WS acepta mensajes `chat` y `system` en JSON — v1.0
- ✓ Mensajes `chat` entrantes se convierten a `NewMessage` y enrutan al agente — v1.0
- ✓ Mensajes `system` entrantes se convierten a `NewMessage` con prefijo `[SYSTEM]` — v1.0
- ✓ `sendMessage()` envía mensajes `chat` al cliente WS conectado — v1.0
- ✓ `setTyping()` envía evento `system/typing` al panel — v1.0
- ✓ Soporte de adjuntos entrantes (base64 → guardado en `groups/better-work/inbox/attachments/`) — v1.0
- ✓ Soporte de adjuntos salientes (archivo → HTTP estático en `groups/better-work/files/`) — v1.0
- ✓ Buffer de mensajes offline (mensajes enviados sin cliente conectado se almacenan temporalmente) — v1.0
- ✓ Canal registrado en `src/index.ts` main() condicionado a `WEBSOCKET_ENABLED` — v1.0
- ✓ Grupo `better-work` auto-registrado al arrancar si no existe — v1.0
- ✓ Estructura de directorios `groups/better-work/` con CLAUDE.md — v1.0
- ✓ Variables de entorno: `WEBSOCKET_ENABLED`, `WEBSOCKET_PORT`, `WEBSOCKET_FILES_PORT` — v1.0
- ✓ WebSocketServer bound a 127.0.0.1 (localhost only) — v1.0
- ✓ `WEBSOCKET_FILES_PORT` wired explícitamente en constructor call — v1.0
- ✓ Documentación de rutas de adjuntos (`inbox/attachments/`, `files/`) en agent CLAUDE.md — v1.0
- ✓ Documentación de write-before-respond timing en agent CLAUDE.md — v1.0

### Active

(Next milestone requirements TBD)

### Out of Scope

- Panel web Next.js — se construye en un milestone posterior
- Autenticación WebSocket — localhost only en v1, no requiere auth
- Split de mensajes largos — el panel gestiona el renderizado
- Multi-cliente WS simultáneo — una conexión a la vez en v1

## Current State (v1.0 shipped 2026-03-02)

**WebSocket channel fully operational** — 3 fases ejecutadas, 5 planes completados, todas las requirements validated.

**Codebase:**
- `src/channels/websocket.ts` — WebSocketChannel class, ~250 LOC, con soporte para mensajes chat/system, adjuntos, buffer offline
- `src/channels/websocket.test.ts` — 35+ tests, full coverage de behavior
- `src/index.ts` — WebSocketChannel instanciada condicionalmente con `WEBSOCKET_ENABLED`
- `groups/better-work/` — Directorio preconfigurado con `CLAUDE.md` documentando rutas y operaciones
- `.planning/phases/01-03/` — Fases 1-3 con SUMMARY.md y VERIFICATION.md documentando decisiones y tech debt

**Tech Stack:**
- `ws` package v8.x para WebSocket server
- HTTP estático vía http.createServer para archivos (puerto `WEBSOCKET_FILES_PORT=3002`)
- JIDs prefijados con `ws:` (e.g., `ws:better-work`)
- Localhost binding (127.0.0.1) — no internet exposure en v1

**Known Limitations:**
- Single concurrent WebSocket connection per group (v1 design)
- No authentication (localhost trust model)
- Panel web not yet built (separate milestone)

## Constraints

- **Tech stack**: TypeScript + Node.js — añadir solo `ws` y `@types/ws` como dependencias
- **Compatibilidad**: El canal debe funcionar sin cambios en el orquestador principal, solo añadir bloque `if (WEBSOCKET_ENABLED)` en main()
- **Package manager**: npm (ya tiene `package-lock.json`)
- **Seguridad**: localhost only — no exponer WS a internet en v1

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Puerto separado para HTTP estático | PRD sugiere 3002 para archivos; permite CORS independiente del WS | ✓ Implemented — `WEBSOCKET_FILES_PORT=3002` |
| Auto-registro de `better-work` en main() | Más robusto que registro manual vía Telegram; evita dependencia operacional | ✓ Working — grupo auto-registrado en startup |
| Mensajes `system` como `NewMessage` con `[SYSTEM]` prefix | Reutiliza el pipeline de mensajes existente sin cambios en el orquestador | ✓ Verified — system messages arrive prefixed |
| `requiresTrigger: false` para better-work | Todo mensaje del panel va al agente sin necesidad de @mention | ✓ Implemented — all panel messages trigger agent |
| Localhost binding (127.0.0.1) | Seguridad v1 — no exponerse a internet, confianza en host | ✓ Implemented — WebSocketServer y HTTP static bound to 127.0.0.1 |
| Wiring explícito de `WEBSOCKET_FILES_PORT` en constructor | Evita coupling silencioso a defaults de config | ✓ Implemented — port passed explicitly en main() |

---

## Next Milestone

TBD — new requirements cycle pending.

---

*Last updated: 2026-03-02 after v1.0 completion*
