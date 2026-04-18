# Cycle de vie des containers

## États d'une session

```
          ┌─────────────────────────────────────────────┐
          │                                             │
          ▼                                             │
       stopped ──── wakeContainer() ────▶ spawning ────┤
          ▲                                    │        │
          │                                    ▼        │
          │                               running       │
          │                                  │          │
          │                         idle timeout 30min  │
          │                                  │          │
          └─────── killContainer() ─────── idle ────────┘
                                              │
                              stale (heartbeat > 10min)
                                              │
                                     reset to 'stopped'
                                     messages_in → pending
                                     backoff exponentiel
```

---

## Spawn d'un container (`container-runner.ts`)

```typescript
wakeContainer(sessionId, agentGroupId)

// 1. Déduplication
if (wakePromises.has(sessionId)) return wakePromises.get(sessionId)
if (activeContainers.has(sessionId)) return

// 2. Rafraîchir les projections avant spawn
writeDestinations(sessionId, agentGroupId)
writeSessionRouting(sessionId, ...)

// 3. Construire les mounts
buildMounts() :
  /workspace/inbound.db   ← ro: data/v2-sessions/<agId>/<sessId>/inbound.db
  /workspace/outbound.db  ← rw: data/v2-sessions/<agId>/<sessId>/outbound.db
  /workspace/.heartbeat   ← rw: data/v2-sessions/<agId>/<sessId>/.heartbeat
  /workspace/outbox/      ← rw: data/v2-sessions/<agId>/<sessId>/outbox/
  /workspace/agent/       ← ro: groups/<folder>/
  /workspace/.claude/     ← rw: data/v2-sessions/<agId>/.claude-shared/
  // + extra mounts du container_config

// 4. Spawn
spawn(dockerBin, [
  "run", "--rm",
  "--name", `nanoclaw-${sessionId}`,
  "--env", "SESSION_INBOUND_DB_PATH=/workspace/inbound.db",
  "--env", "SESSION_OUTBOUND_DB_PATH=/workspace/outbound.db",
  "--env", "AGENT_PROVIDER=claude",
  "--env", `TZ=${timezone}`,
  // ... autres env vars
  ...mounts,
  "nanoclaw-agent:latest",
  "exec bun /workspace/agent-runner/src/index.ts"
])

// 5. Tracking
activeContainers.set(sessionId, process)
markContainerRunning(sessionId)
startIdleTimer(sessionId, 30min)
```

---

## Idle timer

Chaque livraison réussie appelle `resetIdleTimer()` — le container reste chaud tant que l'agent produit des messages. À la fin de l'inactivité :

```
idleTimeout fires
  → killContainer(sessionId)
  → process.kill('SIGTERM')
  → activeContainers.delete(sessionId)
  → markContainerStopped(sessionId)
  → stopTypingRefresh(sessionId)
```

---

## Stale detection (`host-sweep.ts`)

Toutes les 60s, `sweepSession()` vérifie chaque session active :

```
pour chaque session avec container_status='running' :
  heartbeatAge = now - mtime(.heartbeat)
  
  si heartbeatAge > STALE_THRESHOLD (10min) :
    ET processing_ack contient des entrées 'processing' :
      → container considéré crashé
      
      pour chaque message bloqué en 'processing' :
        tries++
        si tries >= MAX_TRIES (5) : status='failed'
        sinon :
          backoff = 5s × 2^tries
          process_after = now + backoff
          status='pending'
      
      markContainerStopped(sessionId)
```

---

## Mounts détaillés

```
Host path                                    Container path        Mode
─────────────────────────────────────────────────────────────────────────
data/v2-sessions/<agId>/<sessId>/inbound.db  /workspace/inbound.db   ro
data/v2-sessions/<agId>/<sessId>/outbound.db /workspace/outbound.db  rw
data/v2-sessions/<agId>/<sessId>/.heartbeat  /workspace/.heartbeat   rw
data/v2-sessions/<agId>/<sessId>/outbox/     /workspace/outbox/      rw
data/v2-sessions/<agId>/<sessId>/inbox/      /workspace/inbox/       ro
groups/<folder>/                             /workspace/agent/       ro
data/v2-sessions/<agId>/.claude-shared/      /workspace/.claude/     rw
container/agent-runner/src/                  /app/src/               ro (dev only)
```

Le container n'a pas accès au reste du système de fichiers host — isolation par design.

---

## Variables d'environnement injectées

```
SESSION_INBOUND_DB_PATH    /workspace/inbound.db
SESSION_OUTBOUND_DB_PATH   /workspace/outbound.db
SESSION_HEARTBEAT_PATH     /workspace/.heartbeat
AGENT_PROVIDER             claude | opencode | codex
NANOCLAW_ASSISTANT_NAME    nom de l'agent (depuis agent_groups)
NANOCLAW_ADMIN_USER_IDS    liste des user IDs admin (pour accès MCP)
NANOCLAW_MCP_SERVERS       JSON des MCP servers supplémentaires
TZ                         timezone de l'hôte
```
