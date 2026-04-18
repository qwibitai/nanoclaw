# NanoClaw — Documentation personnelle

Documentation complète du fonctionnement de NanoClaw v2.

## Sommaire

| Document | Contenu |
|----------|---------|
| [01-vue-ensemble.md](01-vue-ensemble.md) | Vue d'ensemble, philosophie, schéma général |
| [02-modele-entites.md](02-modele-entites.md) | Modèle d'entités (users, groups, sessions, DB centrale) |
| [03-flux-message.md](03-flux-message.md) | Flux complet d'un message : réception → agent → livraison |
| [04-session-db.md](04-session-db.md) | Les deux DBs de session (inbound/outbound) et leurs invariants |
| [05-container-lifecycle.md](05-container-lifecycle.md) | Cycle de vie des containers (spawn, heartbeat, idle, stale) |
| [06-agent-runner.md](06-agent-runner.md) | Internals de l'agent-runner (poll loop, provider, MCP tools) |
| [07-channels.md](07-channels.md) | Système d'adaptateurs de canaux |
| [08-delivery.md](08-delivery.md) | Système de livraison (active poll, sweep, approbations) |
| [09-fonctions-avancees.md](09-fonctions-avancees.md) | Questions interactives, scheduling, agent-to-agent, self-mod |
