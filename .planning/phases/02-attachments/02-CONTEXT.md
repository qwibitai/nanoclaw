# Phase 2: Attachments - Context

**Gathered:** 2026-03-01
**Status:** Ready for planning

<domain>
## Phase Boundary

Extensión del canal WebSocket para transferencia de archivos bidireccional: adjuntos entrantes (base64 desde el panel → disco) y adjuntos salientes (archivos del agente → HTTP estático accesible desde el panel). El canal WS en sí ya existe (Phase 1). Esta fase solo añade el manejo de archivos.

</domain>

<decisions>
## Implementation Decisions

### Protocolo entrante
- El panel extiende el mensaje chat existente con un campo `attachments`: `{type:"chat", content, attachments:[{name, data, mime, size}]}`
- Campos por adjunto: `name` (nombre original), `data` (base64), `mime` (tipo MIME), `size` (bytes)
- Un mensaje con adjuntos puede tener `content` vacío — es válido enviar solo archivos sin texto
- Sin restricciones de MIME types ni tamaño máximo en v1

### Referencia al agente
- El path relativo del archivo guardado se añade (append) al content del mensaje que recibe el agente
- El formato exacto de la referencia es discreción de Claude
- Múltiples adjuntos: discreción de Claude (una línea por archivo o bloque agrupado)
- Naming de archivos en disco: discreción de Claude (preservar nombre original con manejo de colisiones, o timestamp prefix)

### Adjuntos salientes
- El mensaje de respuesta sigue el mismo formato que el entrante, pero con `url` en lugar de `data`: `{type:"chat", content, attachments:[{name, url}]}`
- Mecanismo de detección de archivos salientes: discreción de Claude
- URL relativa vs absoluta en el mensaje de salida: discreción de Claude
- El agente escribe archivos en `groups/better-work/files/` directamente; NanoClaw los sirve desde ahí

### Servidor HTTP estático
- Comportamiento de CORS: discreción de Claude
- Sin limpieza automática de archivos en v1 (los archivos persisten indefinidamente)
- Cuándo arranca el servidor HTTP (siempre vs bajo demanda): discreción de Claude
- Comportamiento si el puerto ya está en uso: discreción de Claude

### Claude's Discretion
- Formato exacto de la referencia al agente en el content
- Manejo de múltiples adjuntos en el content (una línea vs bloque)
- Naming de archivos en disco (nombre original + colisiones, o timestamp prefix)
- Mecanismo de detección de archivos salientes (scan de texto, watch de directorio, u otro)
- URL relativa (`/files/...`) vs absoluta (`http://localhost:3002/files/...`) en mensajes salientes
- CORS headers del servidor HTTP
- Política de arranque del servidor HTTP (siempre con WS, o bajo demanda)
- Comportamiento en conflicto de puerto (log + continuar, o error fatal)

</decisions>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 02-attachments*
*Context gathered: 2026-03-01*
