# Roadmap: NanoClaw — Better Copilot

## Milestones

- ✅ **v1.0 WebSocket Channel** — Fases 1-2 (shipped 2026-03-02)

## Phases

<details>
<summary>✅ v1.0 WebSocket Channel (Phases 1-2) — SHIPPED 2026-03-02</summary>

- [x] Phase 1: WebSocket Channel (3/3 plans) — completed 2026-03-01
- [x] Phase 2: Attachments (1/1 plan) — completed 2026-03-01

</details>

## Phase Details

### Phase 1: WebSocket Channel (v1.0)
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
- [x] 01-01-PLAN.md — Dependencias ws + constantes config (WEBSOCKET_ENABLED, WEBSOCKET_PORT)
- [x] 01-02-PLAN.md — WebSocketChannel completo + tests de comportamiento
- [x] 01-03-PLAN.md — Integración en main() y auto-provisión del grupo better-work

### Phase 2: Attachments (v1.0)
**Goal**: El panel web puede enviar archivos al agente y el agente puede compartir archivos de vuelta al panel via HTTP
**Depends on**: Phase 1
**Requirements**: ATT-01, ATT-02, ATT-03, CONF-03
**Success Criteria** (what must be TRUE):
  1. Un adjunto enviado desde el panel (base64) se guarda en `groups/better-work/inbox/attachments/` y el agente recibe la referencia en el mensaje
  2. Un archivo generado por el agente en `groups/better-work/files/` es accesible via HTTP en el puerto configurado (default 3002)
  3. El mensaje de respuesta del agente incluye la URL `/files/...` cuando hay adjuntos salientes
**Plans**: 1/1 plan

Plans:
- [x] 02-01-PLAN.md — WEBSOCKET_FILES_PORT config + adjuntos entrantes + HTTP estático + adjuntos salientes

## Progress

**Milestone Phases:**

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. WebSocket Channel | v1.0 | 3/3 | Complete | 2026-03-01 |
| 2. Attachments | v1.0 | 1/1 | Complete | 2026-03-01 |
| 3. Tech Debt Fixes | Gap Closure | 1/1 | Complete | 2026-03-02 |

---

## Future Phases

(To be planned in next milestone cycle)

---
