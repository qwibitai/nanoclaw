# BHD-ITSM-Agent

**Blackhawk Data ITSM Agent** — AI-powered IT service management automation for managed service providers.

Dedicated AI agents triage Vivantio ITSM tickets, search knowledge bases, analyze client history, and post resolutions — all autonomously. Each client gets a fully isolated agent with no data leakage. Specialist agents (Cisco, Fortinet, Microsoft, Cybersecurity) handle escalations.

---

## Features

- **Vivantio ITSM Integration** — Polls for new tickets, triages, searches KB, updates with findings
- **Agent Manager Portal** — Web UI to create/manage agents, teams, knowledge bases, and chat with agents
- **Per-Client Isolation** — Dedicated agent per client with separate filesystem, memory, and API filters
- **Specialist Agents** — Cisco, Fortinet, Microsoft 365, and Cybersecurity experts for escalations
- **Team Orchestration** — Escalation rules route tickets to the right specialist automatically
- **Knowledge Base Management** — Upload docs per scope (global, specialist, client)
- **Real-Time Chat** — WebSocket chat to program agents, request updates, test triage
- **Audit Logging** — Full trail of every agent action, ticket update, and escalation
- **Container Isolation** — Each agent runs in its own Linux container with filesystem sandboxing
- **Scheduled Tasks** — Automated follow-ups, pattern detection, SLA monitoring

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    BHD-ITSM-Agent                        │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ Portal UI    │  │ Portal API   │  │ Vivantio     │  │
│  │ (Next.js)    │  │ (:3100)      │  │ Channel      │  │
│  │ :3200        │  │ REST + WS    │  │ (Poller)     │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  │
│         │                 │                  │          │
│         └─────────┬───────┘                  │          │
│                   │                          │          │
│  ┌────────────────▼──────────────────────────▼───────┐  │
│  │              Core Engine                          │  │
│  │  SQLite DB │ Container Runner │ Group Queue       │  │
│  └──────────────────────┬────────────────────────────┘  │
│                         │                               │
│  ┌──────────────────────▼────────────────────────────┐  │
│  │           Isolated Agent Containers               │  │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌────────┐ │  │
│  │  │Client A │ │Client B │ │CiscoBot │ │CyberWch│ │  │
│  │  │Agent    │ │Agent    │ │Specialist│ │SOC     │ │  │
│  │  └─────────┘ └─────────┘ └─────────┘ └────────┘ │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

## Quick Start

### Prerequisites

- Ubuntu 22.04+ or Debian 12+ (Linux server)
- Node.js 20+
- Docker
- [Claude Code](https://claude.com/product/claude-code) (for AI agent runtime)

### Deploy

```bash
# Clone the repository
git clone https://github.com/bhd-cap/BHD-ITSM-Agent.git
cd BHD-ITSM-Agent

# Run the automated setup script
./deploy/setup.sh
```

The setup script handles:
1. System dependency installation (Node.js, Docker)
2. NPM dependency installation (backend + portal)
3. Container image build
4. Environment configuration (`.env` from template)
5. TypeScript compilation
6. systemd service installation
7. Portal build

### Manual Setup

```bash
# Install dependencies
npm install
cd portal && npm install && cd ..

# Copy environment template and configure
cp .env.example .env
# Edit .env with your API keys

# Build
npm run build
npm run portal:build

# Build agent container
./container/build.sh

# Start
npm start
```

## Configuration

Copy `.env.example` to `.env` and fill in your credentials:

```bash
# Required — Claude API
ANTHROPIC_API_KEY=your-anthropic-api-key

# Required — Vivantio ITSM
VIVANTIO_API_TOKEN=your-vivantio-api-token
VIVANTIO_BASE_URL=https://webservices-na01.vivantio.com
VIVANTIO_AGENT_USER_ID=12345
VIVANTIO_POLL_INTERVAL=60000

# Portal (Agent Manager Web UI)
PORTAL_PORT=3100
PORTAL_JWT_SECRET=generate-a-secure-random-string
PORTAL_ADMIN_EMAIL=admin@blackhawkdata.com
PORTAL_ADMIN_PASSWORD=change-this-immediately

# Agent Configuration
ASSISTANT_NAME=BHDAgent
CONTAINER_IMAGE=bhd-itsm-agent:latest
MAX_CONCURRENT_CONTAINERS=5
CONTAINER_TIMEOUT=1800000
```

## Service Management

```bash
# Start/stop/restart
sudo systemctl start bhd-itsm-agent
sudo systemctl stop bhd-itsm-agent
sudo systemctl restart bhd-itsm-agent

# View logs
journalctl -u bhd-itsm-agent -f

# Check status
sudo systemctl status bhd-itsm-agent
```

## Portal Access

After deployment, the Agent Manager Portal is available at:

- **URL:** `http://your-server:3200`
- **Default Login:** `admin@blackhawkdata.com` / `changeme` (change immediately)

### Portal Features

| Page | Purpose |
|------|---------|
| Dashboard | Live agent status, ticket queue, response times, activity feed |
| Agents | Create/edit agents — role, specializations, triage behavior, custom instructions |
| Teams | Build agent teams with escalation rules (category/priority routing) |
| Knowledge Base | Upload documents per scope (global, specialist, client-only) |
| Chat | Real-time chat with any agent — program behavior, request updates |
| Tickets | Ticket activity dashboard with agent action timeline |
| Audit Logs | Full audit trail filterable by agent |

## Agent Types

### Dedicated Client Agent
Assigned to a single client. Handles all their tickets with full context of their environment, history, and KB. Completely isolated from other clients.

### Specialist Agents

| Agent | Expertise |
|-------|-----------|
| **CiscoBot** | Meraki, Catalyst, ISE, AnyConnect, DNA Center, SD-WAN |
| **FortiBot** | FortiGate, FortiAnalyzer, FortiClient, FortiSIEM, FortiEDR |
| **MSAgent** | Microsoft 365, Azure AD/Entra, Intune, Windows Server |
| **CyberWatch** | SIEM triage, EDR alerts, incident response (NIST 800-61), phishing |

### Cybersecurity Response Agent
Monitors security alerts across all clients. Classifies severity, identifies IOCs, recommends containment. Escalates P1/P2 to human SOC analysts immediately.

## Project Structure

```
BHD-ITSM-Agent/
├── src/                    # Core engine
│   ├── index.ts            # Orchestrator: state, message loop, agent invocation
│   ├── portal-api/         # Portal REST API + WebSocket server
│   │   ├── server.ts       # HTTP server (port 3100)
│   │   ├── db-portal.ts    # Portal database schema + CRUD
│   │   ├── routes/         # API route handlers
│   │   └── services/       # Agent provisioner, activity logger
│   ├── channels/           # Messaging channel adapters
│   ├── container-runner.ts # Spawns isolated agent containers
│   ├── db.ts               # SQLite database operations
│   └── config.ts           # Configuration constants
├── portal/                 # Next.js web portal
│   └── src/app/            # Pages: dashboard, agents, teams, KB, chat, tickets, logs
├── container/              # Agent container image
│   ├── Dockerfile
│   ├── build.sh
│   └── agent-runner/       # Code that runs inside agent containers
├── deploy/                 # Deployment scripts
│   ├── setup.sh            # Automated server setup
│   ├── bhd-itsm-agent.service  # systemd unit file
│   └── update.sh           # Pull + rebuild + restart
├── groups/                 # Per-agent isolated directories
│   ├── main/CLAUDE.md      # Admin agent memory
│   └── global/CLAUDE.md    # Shared read-only memory
├── .env.example            # Environment variable template
└── docs/                   # Architecture and planning docs
```

## Development

```bash
# Run backend with hot reload
npm run dev

# Run portal frontend (separate terminal)
npm run portal:dev

# Run tests
npm test

# Type check
npm run typecheck

# Rebuild agent container
./container/build.sh
```

## Security

- **Container isolation** — Each agent runs in its own Docker container with filesystem sandboxing
- **Per-client data separation** — Separate group folders, sessions, KB, and Vivantio query filters
- **Credential proxy** — API tokens never enter containers; injected by host-side proxy
- **JWT authentication** — Portal access requires authentication with role-based permissions
- **Audit trail** — Every agent action logged with timestamps for compliance

## License

Proprietary — Blackhawk Data Corporation. All rights reserved.
