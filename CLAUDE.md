# BHD-ITSM-Agent

Blackhawk Data ITSM Agent — AI-powered ticket triage and managed services automation with Vivantio integration and Agent Manager Portal.

## Quick Context

Single Node.js process with Vivantio ITSM integration and agent management web portal. AI agents run in isolated Docker containers to triage tickets, search knowledge bases, and post resolutions. Each client gets a dedicated agent with full data isolation. The Agent Manager Portal (port 3100/3200) provides web-based agent creation, team management, KB management, and real-time chat.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/portal-api/server.ts` | Portal REST API + WebSocket server (port 3100) |
| `src/portal-api/db-portal.ts` | Portal database schema + CRUD operations |
| `src/portal-api/routes/` | API routes: agents, teams, KB, chat, tickets, logs, auth |
| `src/portal-api/services/agent-provisioner.ts` | Creates groups, CLAUDE.md, registers agents |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/db.ts` | SQLite operations |
| `src/config.ts` | Configuration constants |
| `portal/` | Next.js Agent Manager Portal frontend |
| `groups/{name}/CLAUDE.md` | Per-agent memory (isolated) |
| `deploy/` | Deployment scripts (setup.sh, systemd unit, update.sh) |

## Development

Run commands directly — don't tell the user to run them.

```bash
npm run dev          # Run backend with hot reload
npm run portal:dev   # Run portal frontend (separate terminal)
npm run build        # Compile TypeScript
npm run portal:build # Build portal for production
./container/build.sh # Rebuild agent container
npm test             # Run tests
```

Service management (Linux):
```bash
sudo systemctl start bhd-itsm-agent
sudo systemctl stop bhd-itsm-agent
sudo systemctl restart bhd-itsm-agent
journalctl -u bhd-itsm-agent -f
```

## Portal API

The portal API server runs on port 3100 with JWT authentication:

- `POST /api/auth/login` — Login
- `GET/POST/PUT/DELETE /api/agents` — Agent CRUD
- `GET/POST/PUT/DELETE /api/teams` — Team management
- `GET/POST/PUT/DELETE /api/kb` — Knowledge base management
- `POST /api/chat/:agentId` — Send message to agent
- `GET /api/dashboard/stats` — Dashboard metrics
- `GET /api/tickets` — Ticket activity
- `GET /api/logs` — Audit log

## Agent Provisioning

When an agent is created via the portal:
1. `groups/viv_{slug}/` directory is created with `CLAUDE.md`, `kb/`, `logs/`
2. CLAUDE.md is auto-generated from role + specializations + custom instructions
3. The agent is registered in the group system
4. Vivantio channel filters tickets by ClientId for dedicated agents

## Specialization Templates

Available specializations for agents:
- `general` — General IT support
- `cisco` — Cisco networking (Meraki, Catalyst, ISE, AnyConnect)
- `fortinet` — Fortinet security (FortiGate, FortiAnalyzer, FortiClient)
- `microsoft` — Microsoft 365 / Azure (Exchange, Teams, Entra, Intune)
- `cybersecurity` — SOC / incident response (SIEM, EDR, NIST 800-61)

## Client Isolation

Each client agent gets:
- Own `groups/{folder}/` directory
- Own container with no cross-mounts
- Own CLAUDE.md memory
- Own session history
- Own KB directory
- Vivantio queries pre-filtered by ClientId

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
