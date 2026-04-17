# Agent-Hub Coupling

> This repository is **coupled to iAsh (agent-hub)** and registered in `iAsh/data/agents/topology.json`.

## Coupling Configuration

| Setting | Value |
|---|---|
| Registry | `AiFeatures/iAsh/data/agents/topology.json` |
| Environment variable | `AGENT_HUB_URL` (default: `http://localhost:5000`) |
| Health check path | `/api/health` |

## Environment Setup

Add the following to your `.env` file:

```bash
AGENT_HUB_URL=http://localhost:5000
# For production: https://agent-hub.iaify.se
```

## Registering at Runtime

On startup, this service should register itself with agent-hub:

```python
# Python example
import os, requests
requests.post(
    f"{os.environ['AGENT_HUB_URL']}/api/registry/register",
    json={"repo": "<this-repo>", "health": "/api/health"}
)
```

```typescript
// TypeScript example
import { AgentHubClient } from '@agent-hub/sdk';
const hub = new AgentHubClient(process.env.AGENT_HUB_URL);
await hub.register({ repo: '<this-repo>', health: '/api/health' });
```

## Coordination

- Changes to public API surface must be coordinated with `iAsh` maintainers
- Breaking changes require a PR to `iAsh/data/agents/topology.json` first
- Health endpoint must return 200 for `iAsh` to mark this repo as "healthy"

## See Also

- [agent-hub/config/coupled-repos.json](https://github.com/AiFeatures/iAsh/blob/main/config/coupled-repos.json)
- [Enterprise governance](https://github.com/Ai-road-4-You/governance)
