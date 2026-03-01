# Roadmap: NanoClaw — Better Copilot (WebSocket Channel)

## Overview

Dos fases para añadir el canal WebSocket a NanoClaw: primero el canal completamente funcional con protocolo de mensajes e integración en el orquestador, luego el soporte de adjuntos con servidor HTTP estático. Al terminar, el panel web puede comunicarse con el agente better-work en tiempo real.

## Phases

- [ ] **Phase 1: WebSocket Channel** - Canal WS funcional con protocolo de mensajes, buffer offline e integración en main()
- [ ] **Phase 2: Attachments** - Adjuntos entrantes (base64) y salientes (HTTP estático)

## Phase Details

### Phase 1: WebSocket Channel
**Goal**: El canal WebSocket está operativo — el panel web puede enviar y recibir mensajes al agente better-work en tiempo real
**Depends on**: Nothing (first phase)
**Requirements**: CHAN-01, CHAN-02, CHAN-03, CHAN-04, CHAN-05, CHAN-06, PROTO-01, PROTO-02, PROTO-03, PROTO-04, PROTO-05, CONF-01, CONF-02, INTG-01, INTG-02, INTG-03
**Success Criteria** (what must be TRUE):
  1. NanoClaw arranca con el canal WS escuchando en el puerto configurado (default 3001)
  2. Un cliente WS puede enviar un mensaje `{type:"chat"}` y el agente better-work lo recibe y responde
  3. Un mensaje `{type:"system"}` entrante llega al agente con prefijo `[SYSTEM]` en el content
  4. Si el cliente WS se desconecta y reconecta, los mensajes enviados durante la desconexion se entregan al reconectar
  5. El grupo `better-work` existe en la DB y en `groups/better-work/` al arrancar, sin intervención manual
**Plans**: 3 plans

Plans:
- [ ] 01-01-PLAN.md — Dependencias ws + constantes config (WEBSOCKET_ENABLED, WEBSOCKET_PORT)
- [ ] 01-02-PLAN.md — WebSocketChannel completo + tests de comportamiento
- [ ] 01-03-PLAN.md — Integración en main() y auto-provisión del grupo better-work

### Phase 2: Attachments
**Goal**: El panel web puede enviar archivos al agente y el agente puede compartir archivos de vuelta al panel via HTTP
**Depends on**: Phase 1
**Requirements**: ATT-01, ATT-02, ATT-03, CONF-03
**Success Criteria** (what must be TRUE):
  1. Un adjunto enviado desde el panel (base64) se guarda en `groups/better-work/inbox/attachments/` y el agente recibe la referencia en el mensaje
  2. Un archivo generado por el agente en `groups/better-work/files/` es accesible via HTTP en el puerto configurado (default 3002)
  3. El mensaje de respuesta del agente incluye la URL `/files/...` cuando hay adjuntos salientes
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. WebSocket Channel | 0/3 | Planned | - |
| 2. Attachments | 0/? | Not started | - |
