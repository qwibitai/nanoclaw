# Vue d'ensemble de NanoClaw

## Philosophie

NanoClaw est un assistant Claude personnel. Le host est un unique processus Node qui orchestre des containers agent Docker par session. Les messages arrivent via des adaptateurs de canaux, transitent par un modèle d'entités, et déclenchent un container qui exécute Claude via le Claude Agent SDK.

**Principe fondamental : tout est message.** Il n'y a pas d'IPC, pas de file watcher, pas de stdin entre host et container. Les deux DBs de session sont l'unique surface d'IO.

---

## Schéma général

```
┌─────────────────────────────────────────────────────────────────────┐
│                        PLATEFORMES EXTERNES                         │
│   Telegram  Discord  Slack  WhatsApp  GitHub  Linear  ...           │
└──────────┬──────────────────────────────────────────────────────────┘
           │ événements
           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         HOST NODE PROCESS                           │
│                                                                     │
│  ┌──────────────┐   ┌──────────────┐   ┌─────────────────────────┐ │
│  │ Channel      │   │   Router     │   │  Session Manager        │ │
│  │ Adapters     │──▶│ (router.ts)  │──▶│  (session-manager.ts)   │ │
│  │ (channels/)  │   │              │   │  inbound.db write       │ │
│  └──────────────┘   └──────────────┘   └──────────┬──────────────┘ │
│                                                   │ wake            │
│  ┌──────────────┐                      ┌──────────▼──────────────┐ │
│  │  Delivery    │◀─────────────────────│ Container Runner        │ │
│  │ (delivery.ts)│   outbound.db read   │ (container-runner.ts)   │ │
│  │  1s poll     │                      │  docker run ...         │ │
│  └──────┬───────┘                      └─────────────────────────┘ │
│         │                                                           │
│  ┌──────▼───────┐   ┌──────────────────────────────────────────┐   │
│  │ Host Sweep   │   │           data/v2.db (SQLite)            │   │
│  │ (60s)        │   │  users, sessions, agent_groups,          │   │
│  └──────────────┘   │  messaging_groups, pending_*, ...        │   │
│                      └──────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
           │ docker mounts
           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    CONTAINER AGENT (Docker / Bun)                   │
│                                                                     │
│  ┌──────────────┐   ┌──────────────┐   ┌─────────────────────────┐ │
│  │  Poll Loop   │──▶│  Provider    │──▶│   Claude Agent SDK      │ │
│  │ (poll-loop)  │   │  (claude.ts) │   │   @anthropic-ai/        │ │
│  │ inbound read │   └──────────────┘   │   claude-agent-sdk      │ │
│  └──────┬───────┘                      └─────────────────────────┘ │
│         │                                          │ MCP tools      │
│  ┌──────▼───────┐                      ┌──────────▼──────────────┐ │
│  │ outbound.db  │◀─────────────────────│  MCP Tool Server        │ │
│  │   write      │                      │  send_message, ask_user │ │
│  └──────────────┘                      │  schedule_task, ...     │ │
│                                        └─────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Composants principaux

### Host (Node + pnpm)

| Fichier | Rôle |
|---------|------|
| `src/index.ts` | Point d'entrée : init DB, migrations, adapters, polls, shutdown |
| `src/router.ts` | Routing entrant : messaging group → agent group → session → inbound.db |
| `src/delivery.ts` | Poll outbound.db, livraison via adapter, approbations |
| `src/host-sweep.ts` | Sweep 60s : stale detection, recurrence, retries |
| `src/session-manager.ts` | Résolution de session, création des DBs, projections |
| `src/container-runner.ts` | Spawn des containers Docker par session |
| `src/channels/` | Registre des adaptateurs de canaux |
| `src/db/` | Couche DB centrale (CRUD par entité) |

### Container (Bun)

| Fichier | Rôle |
|---------|------|
| `container/agent-runner/src/index.ts` | Point d'entrée container, config provider, MCP |
| `container/agent-runner/src/poll-loop.ts` | Boucle principale : poll inbound, invoke provider |
| `container/agent-runner/src/formatter.ts` | Formatage des messages pour le prompt |
| `container/agent-runner/src/providers/` | Wrappers SDK (claude, codex, opencode) |
| `container/agent-runner/src/mcp-tools/` | Outils MCP (send, schedule, ask, agents, self-mod) |

---

## Intervalles clés

| Composant | Intervalle | But |
|-----------|-----------|-----|
| Active delivery poll | 1s | Sessions actives, réponse rapide |
| Sweep delivery poll | 60s | Toutes les sessions, messages schedulés |
| Host sweep | 60s | Stale detection, récurrence, retries |
| Agent poll loop (idle) | 1s | Pickup de nouveaux messages |
| Agent poll loop (query) | 500ms | Follow-ups continus pendant traitement |
| Idle timeout container | 30 min | Tuer le container chaud après inactivité |
| Stale threshold | 10 min | Détecter container crashé via heartbeat |
