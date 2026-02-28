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

### Active

<!-- Scope de este milestone: WebSocket channel -->

- [ ] Canal WebSocket implementa interfaz `Channel` (`src/channels/websocket.ts`)
- [ ] Servidor WS acepta mensajes `chat` y `system` en JSON
- [ ] Mensajes `chat` entrantes se convierten a `NewMessage` y enrutan al agente
- [ ] Mensajes `system` entrantes se convierten a `NewMessage` con prefijo `[SYSTEM]`
- [ ] `sendMessage()` envía mensajes `chat` al cliente WS conectado
- [ ] `setTyping()` envía evento `system/typing` al panel
- [ ] Soporte de adjuntos entrantes (base64 → guardado en `groups/better-work/inbox/attachments/`)
- [ ] Soporte de adjuntos salientes (archivo → HTTP estático en `groups/better-work/files/`)
- [ ] Buffer de mensajes offline (mensajes enviados sin cliente conectado se almacenan temporalmente)
- [ ] Canal registrado en `src/index.ts` main() condicionado a `WEBSOCKET_ENABLED`
- [ ] Grupo `better-work` auto-registrado al arrancar si no existe
- [ ] Estructura de directorios `groups/better-work/` con CLAUDE.md
- [ ] Variables de entorno: `WEBSOCKET_ENABLED`, `WEBSOCKET_PORT`, `WEBSOCKET_FILES_PORT`

### Out of Scope

- Panel web Next.js — se construye en un milestone posterior
- Autenticación WebSocket — localhost only en v1, no requiere auth
- Split de mensajes largos — el panel gestiona el renderizado
- Multi-cliente WS simultáneo — una conexión a la vez en v1

## Context

NanoClaw ya tiene una abstracción `Channel` bien definida. El nuevo canal sigue exactamente el mismo patrón que `src/channels/telegram.ts`. Los JIDs usan prefijo `ws:` (e.g., `ws:better-work`). El grupo `better-work` es el contexto laboral de Daniel en Better Consultants (proyectos Java Legacy sobre WebLogic, comunicación frecuente en catalán, cliente Mossos d'Esquadra).

El servidor HTTP estático para archivos salientes puede compartir proceso con el WS server (http.createServer + ws.Server) o usar express mínimo. El PRD sugiere puerto separado (`WEBSOCKET_FILES_PORT=3002`) pero puede simplificarse a un path `/files/` en el mismo puerto.

## Constraints

- **Tech stack**: TypeScript + Node.js — añadir solo `ws` y `@types/ws` como dependencias
- **Compatibilidad**: El canal debe funcionar sin cambios en el orquestador principal, solo añadir bloque `if (WEBSOCKET_ENABLED)` en main()
- **Package manager**: npm (ya tiene `package-lock.json`)
- **Seguridad**: localhost only — no exponer WS a internet en v1

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Puerto separado para HTTP estático | PRD sugiere 3002 para archivos; permite CORS independiente del WS | — Pending |
| Auto-registro de `better-work` en main() | Más robusto que registro manual vía Telegram; evita dependencia operacional | — Pending |
| Mensajes `system` como `NewMessage` con `[SYSTEM]` prefix | Reutiliza el pipeline de mensajes existente sin cambios en el orquestador | — Pending |
| `requiresTrigger: false` para better-work | Todo mensaje del panel va al agente sin necesidad de @mention | — Pending |

---
*Last updated: 2026-02-28 after initialization*
