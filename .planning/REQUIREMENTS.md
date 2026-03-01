# Requirements: NanoClaw — Better Copilot (WebSocket Channel)

**Defined:** 2026-02-28
**Core Value:** El agente de trabajo responde al panel web en tiempo real via WebSocket, siguiendo el mismo patrón de canal que Telegram y WhatsApp.

## v1 Requirements

Requirements para implementar el canal WebSocket completo en NanoClaw.

### Channel Core

- [ ] **CHAN-01**: El canal WebSocket implementa la interfaz `Channel` definida en `src/types.ts`
- [ ] **CHAN-02**: `connect()` levanta el servidor WebSocket en el puerto configurado (`WEBSOCKET_PORT`, default 3001)
- [ ] **CHAN-03**: `ownsJid(jid)` retorna `true` para JIDs con prefijo `ws:`
- [ ] **CHAN-04**: `isConnected()` retorna `true` cuando hay al menos un cliente WS conectado
- [ ] **CHAN-05**: Si el cliente se desconecta y reconecta, el servidor sigue funcionando sin reiniciar NanoClaw
- [ ] **CHAN-06**: `disconnect()` cierra el servidor WebSocket limpiamente

### Message Protocol

- [ ] **PROTO-01**: Mensajes entrantes `{type:"chat", content:string}` se convierten a `NewMessage` y se pasan a `opts.onMessage()`
- [ ] **PROTO-02**: Mensajes entrantes `{type:"system", action:string, payload:object}` se convierten a `NewMessage` con content `[SYSTEM] action: payload_json` y se pasan a `opts.onMessage()`
- [ ] **PROTO-03**: `sendMessage(jid, text)` envía `{type:"chat", content:text}` al cliente WS conectado
- [ ] **PROTO-04**: `setTyping(jid, isTyping)` envía `{type:"system", event:"typing", payload:{isTyping}}` al cliente WS
- [ ] **PROTO-05**: Mensajes enviados mientras no hay cliente conectado se almacenan en un buffer limitado y se entregan al reconectar

### Attachments

- [ ] **ATT-01**: Adjuntos entrantes (`attachments[].data` en base64) se guardan en `groups/better-work/inbox/attachments/` y se añade referencia al content del mensaje
- [ ] **ATT-02**: Un servidor HTTP estático sirve `groups/better-work/files/` en `WEBSOCKET_FILES_PORT` (default 3002)
- [ ] **ATT-03**: Archivos salientes se copian a `groups/better-work/files/` y la URL `/files/...` se incluye en el mensaje `chat` con `attachments`

### Configuration

- [x] **CONF-01**: `WEBSOCKET_ENABLED` (env var, default `true`) controla si el canal se registra en `main()`
- [x] **CONF-02**: `WEBSOCKET_PORT` (env var, default `3001`) configura el puerto del servidor WS
- [ ] **CONF-03**: `WEBSOCKET_FILES_PORT` (env var, default `3002`) configura el puerto del servidor HTTP estático

### Integration

- [ ] **INTG-01**: El canal WebSocket se registra en `src/index.ts` `main()` condicionado a `WEBSOCKET_ENABLED`
- [ ] **INTG-02**: El grupo `better-work` se auto-registra en la DB al arrancar si no existe, con `requiresTrigger: false`
- [ ] **INTG-03**: La estructura de directorios `groups/better-work/` se crea con `CLAUDE.md` inicial

## v2 Requirements

### Multi-client

- **MC-01**: Soporte de múltiples clientes WS simultáneos (broadcast)
- **MC-02**: Identificación de clientes individuales para mensajes dirigidos

### Security

- **SEC-01**: Autenticación WS con token (para acceso desde red local no-localhost)
- **SEC-02**: Rate limiting de mensajes entrantes

### Features

- **FEAT-01**: Reconexión automática del cliente (handled by the panel, not NanoClaw)
- **FEAT-02**: Historial de mensajes al reconectar (replay desde DB)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Panel web Next.js | Milestone posterior; esta fase es solo el servidor NanoClaw |
| Autenticación WS | localhost only en v1; no requiere auth |
| Split de mensajes largos | El panel gestiona el renderizado |
| Multi-cliente simultáneo | Una conexión a la vez en v1 |
| WebRTC / media streaming | No necesario para text + files |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| CHAN-01 | Phase 1 | Pending |
| CHAN-02 | Phase 1 | Pending |
| CHAN-03 | Phase 1 | Pending |
| CHAN-04 | Phase 1 | Pending |
| CHAN-05 | Phase 1 | Pending |
| CHAN-06 | Phase 1 | Pending |
| PROTO-01 | Phase 1 | Pending |
| PROTO-02 | Phase 1 | Pending |
| PROTO-03 | Phase 1 | Pending |
| PROTO-04 | Phase 1 | Pending |
| PROTO-05 | Phase 1 | Pending |
| ATT-01 | Phase 2 | Pending |
| ATT-02 | Phase 2 | Pending |
| ATT-03 | Phase 2 | Pending |
| CONF-01 | Phase 1 | Complete |
| CONF-02 | Phase 1 | Complete |
| CONF-03 | Phase 2 | Pending |
| INTG-01 | Phase 1 | Pending |
| INTG-02 | Phase 1 | Pending |
| INTG-03 | Phase 1 | Pending |

**Coverage:**
- v1 requirements: 20 total
- Mapped to phases: 20
- Unmapped: 0 ✓

---
*Requirements defined: 2026-02-28*
*Last updated: 2026-02-28 after initial definition*
