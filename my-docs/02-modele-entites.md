# Modèle d'entités

## DB centrale (`data/v2.db`)

Tout ce qui n'est pas per-session vit ici. Géré exclusivement par le host.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           data/v2.db                                    │
│                                                                         │
│  users                          agent_groups                            │
│  ┌──────────────────────┐       ┌──────────────────────────────────┐   │
│  │ id  (telegram:123)   │       │ id                               │   │
│  │ kind (human/bot)     │       │ folder  (unique)                 │   │
│  │ display_name         │       │ agent_provider (claude/opencode) │   │
│  └──────┬───────────────┘       │ workspace / memory / personality │   │
│         │                       │ container_config (JSON)          │   │
│         │ user_roles            └──────────────┬───────────────────┘   │
│  ┌──────▼───────────────┐                      │                       │
│  │ user_id              │   messaging_groups    │ messaging_group_agents│
│  │ role (owner/admin)   │  ┌────────────────┐  │ ┌──────────────────┐  │
│  │ agent_group_id (NULL │  │ id             │  │ │ mg_id            │  │
│  │  = global)           │  │ channel_type   │  │ │ ag_id            │  │
│  └──────────────────────┘  │ platform_id    │◀─┘ │ session_mode     │  │
│                             │ unknown_sender │    │ trigger_rules    │  │
│  agent_group_members        │  _policy       │    │ priority         │  │
│  ┌──────────────────────┐   └────────────────┘    └──────────────────┘  │
│  │ user_id              │                                               │
│  │ agent_group_id       │   sessions                                    │
│  └──────────────────────┘   ┌────────────────────────────────────────┐  │
│                              │ id                                     │  │
│  user_dms (cache DM froid)   │ agent_group_id                        │  │
│  ┌──────────────────────┐    │ messaging_group_id                    │  │
│  │ user_id              │    │ thread_id                             │  │
│  │ channel_type         │    │ status / container_status             │  │
│  │ messaging_group_id   │    │ agent_provider (override)             │  │
│  └──────────────────────┘    └────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Hiérarchie de droits

```
owner (global)
  └── peut tout faire sur tous les agent groups

admin (global ou scoped à un agent_group_id)
  └── peut gérer le(s) agent group(s) concerné(s)

member (agent_group_members)
  └── accès non-privilégié à un agent group

inconnu
  └── géré par unknown_sender_policy du messaging_group :
        strict           → drop silencieux
        request_approval → demande approbation à l'admin
        public           → autorisé
```

---

## Session — résolution et modes

La table `sessions` est le registre de toutes les conversations actives ou passées.

```
session_mode :

  shared      → 1 session par messaging_group (ignore threadId)
               ┌──────────────────────────────┐
               │  #general (discord)          │──▶ session A
               └──────────────────────────────┘

  per-thread  → 1 session par (messaging_group, threadId)
               ┌──────────────────────────────┐
               │  #general / thread-123       │──▶ session A
               │  #general / thread-456       │──▶ session B
               └──────────────────────────────┘

  agent-shared → 1 session par agent_group (toutes plateformes)
               ┌──────────────────────────────┐
               │  telegram + discord + slack  │──▶ session unique
               └──────────────────────────────┘
```

---

## Structure de fichiers par session

```
data/v2-sessions/
  <agent_group_id>/
    .claude-shared/          ← données SDK Claude partagées par toutes les sessions du groupe
    agent-runner-src/        ← overlay agent-runner per-group (customisations)
    <session_id>/
      inbound.db             ← host écrit, container lit
      outbound.db            ← container écrit, host lit
      .heartbeat             ← container touche (mtime = liveness)
      inbox/<msg_id>/        ← pièces jointes décodées (inbound)
      outbox/<msg_id>/       ← fichiers produits par l'agent (outbound)

groups/
  <folder>/
    CLAUDE.md                ← system prompt du groupe
    skills/                  ← skills container du groupe
    agent-runner-src/        ← overlay agent-runner (optionnel)
```

---

## Tables annexes

| Table | But |
|-------|-----|
| `agent_destinations` | ACL + noms pour `send_message(to="...")` ; projetée dans `inbound.db` au wake |
| `pending_questions` | Questions interactives en attente de réponse utilisateur |
| `pending_approvals` | Approbations admin (install_packages, rebuild, add_mcp_server) |
| `schema_version` | Suivi des migrations |
| `chat_sdk_*` | Tables de bridge Chat SDK (conversations, threads, messages) |
