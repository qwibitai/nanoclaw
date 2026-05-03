# v1 Fork Reference

Diese Dateien dokumentieren Anpassungen aus dem v1-Fork, die nicht direkt
nach v2 portierbar sind (da v2 eine andere Architektur hat).

## CalDAV/CardDAV via dav-mcp (commit 8ae09dc)

**Was es tat:** Integrierte das `dav-mcp`-Paket in den Agent-Container und
mountete `~/.dav-mcp/config.json` read-only in den Container. Gab Agenten
Zugriff auf CalDAV-Kalender, CardDAV-Kontakte und VTODO-Tasks.

**In v2 portieren:** Per `container.json` `mcpServers` konfigurieren oder
als `/add-dav` skill implementieren. Das Mount `~/.dav-mcp → /home/node/.dav-mcp`
muss in der v2-Mount-Allowlist stehen und per `additionalMounts` in `container.json`
eingetragen werden.

**Relevante v1-Dateien:**
- `container/agent-runner/package.json` — `dav-mcp: "*"` hinzugefügt
- `container/agent-runner/src/index.ts` — MCP-Server-Registrierung
- `src/container-runner.ts` — Mount-Logik für `~/.dav-mcp`

## Anytype MCP Integration (commits 531d022, 2122326)

**Was es tat:** Verband NanoClaw mit Anytype über `@anyproto/anytype-mcp`.
Anthropic-API-Key und Anytype-Endpoint wurden als Env-Variablen übergeben.

**In v2 portieren:** Über OneCLI-Vault für Credentials + `container.json`
`mcpServers` konfigurieren. Der `/add-anytype` Skill (nach v2 kopiert) führt
durch die Einrichtung.

**Relevante v1-Dateien:**
- `src/config.ts` — Anytype-Config-Variablen
- `src/container-runner.ts` — Env-Var-Übergabe an Container
- `.claude/skills/add-anytype/SKILL.md` — **in v2 kopiert**
