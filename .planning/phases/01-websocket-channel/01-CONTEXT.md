# Phase 1: WebSocket Channel - Context

**Gathered:** 2026-03-01
**Status:** Ready for planning

<domain>
## Phase Boundary

Implementar el servidor WebSocket como canal de NanoClaw. El panel web puede enviar y recibir mensajes al agente `better-work` en tiempo real. Incluye: servidor WS, protocolo de mensajes, buffer de desconexión, señales de estado, integración en `src/index.ts`, y auto-provisión del grupo `better-work`.

No incluye: panel web Next.js, autenticación WS, multi-cliente simultáneo, adjuntos, historial desde DB.

</domain>

<decisions>
## Implementation Decisions

### Buffer de desconexión (PROTO-05)
- Tamaño máximo: 50 mensajes
- Política de overflow: drop oldest (descarta el más antiguo al llenarse)
- Entrega al reconectar: con indicador — primero `{type:"system", event:"buffered_start", count:N}`, luego los mensajes buffereados, luego `{type:"system", event:"buffered_end"}`
- Los mensajes buffereados llevan su timestamp original para que el panel pueda identificarlos como mensajes diferidos

### Feedback de errores al cliente
- El protocolo incluye un tipo de mensaje explícito: `{type:"error", code:"...", message:"..."}`
- Situaciones que generan error al cliente: errores críticos del agente/servidor + timeouts de respuesta
- Timeout de respuesta del agente: 60 segundos
- Tras enviar un error, el canal sigue activo — el cliente puede continuar enviando mensajes

### Señales de estado del canal
- Al conectar: el servidor envía `{type:"system", event:"connected", payload:{buffered_count:N}}` para confirmar conexión lista e indicar cuántos mensajes buffereados llegan
- Al desconectar el cliente: el servidor envía `[SYSTEM] client_disconnected` al agente para que sepa que no hay cliente escuchando
- Heartbeat: ping cada 30 segundos; si no hay pong en 10 segundos, la conexión se considera zombie y se limpia
- No hay evento de "inicio de procesamiento" separado — el typing indicator (PROTO-04) cubre esa señal

### CLAUDE.md inicial del grupo better-work (INTG-03)
- Rol: asistente de productividad personal
- Idioma de respuesta: siempre español, sin excepciones en respuestas al usuario
- Capacidades multilingüe: puede leer y escribir en catalán e inglés cuando el usuario lo pida explícitamente (emails, documentos); nunca lo hace de forma espontánea
- Herramientas al arrancar: acceso básico al filesystem del grupo (`groups/better-work/`)
- Tono: directo y conciso, sin relleno ni frases de cortesía

</decisions>

<specifics>
## Specific Ideas

- El evento `buffered_start` debe incluir `count:N` para que el panel pueda mostrar "X mensajes mientras estabas desconectado"
- El agente recibe `[SYSTEM] client_disconnected` como mensaje de sistema estándar (mismo mecanismo que PROTO-02)
- El ping/pong usa el mecanismo nativo del protocolo WebSocket (no mensajes de aplicación)

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 01-websocket-channel*
*Context gathered: 2026-03-01*
