# Agent Manager Portal — Blackhawk MSP Orchestration Platform

## Executive Summary

A web portal built on top of NanoClaw that lets Blackhawk create, configure, and manage dedicated AI agents per client. Each agent is fully isolated (no data leaks between clients), can be assigned specialist knowledge (Cisco, Fortinet, Microsoft, cybersecurity), and operates autonomously inside Vivantio ITSM. The portal provides real-time visibility into agent activity, a chat interface for programming agents, team management for multi-agent coordination, and knowledge base management.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Agent Manager Portal                         │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                    Next.js Web Application                    │  │
│  │                                                               │  │
│  │  Dashboard ─ Agent Builder ─ Teams ─ KB Manager ─ Chat ─ Logs│  │
│  └───────────────────────┬───────────────────────────────────────┘  │
│                          │ REST API + WebSocket                     │
│  ┌───────────────────────▼───────────────────────────────────────┐  │
│  │                   Portal API Server                           │  │
│  │                   (Express on port 3100)                      │  │
│  │                                                               │  │
│  │  /api/agents     - CRUD agents                                │  │
│  │  /api/teams      - Agent team management                      │  │
│  │  /api/clients    - Client assignment + isolation               │  │
│  │  /api/kb         - Knowledge base management                  │  │
│  │  /api/tickets    - Ticket dashboard (read from Vivantio)      │  │
│  │  /api/chat       - Chat with agents (WebSocket)               │  │
│  │  /api/logs       - Activity logs + audit trail                │  │
│  │  /api/auth       - Portal authentication                      │  │
│  └───────────────────────┬───────────────────────────────────────┘  │
│                          │                                          │
│  ┌───────────────────────▼───────────────────────────────────────┐  │
│  │                  NanoClaw Core Engine                          │  │
│  │                                                               │  │
│  │  ┌─────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │  │
│  │  │Vivantio │  │Container │  │ Group    │  │ Task         │  │  │
│  │  │Channel  │  │Runner    │  │ Queue    │  │ Scheduler    │  │  │
│  │  │(Poller) │  │(Docker)  │  │          │  │              │  │  │
│  │  └────┬────┘  └────┬─────┘  └────┬─────┘  └──────┬───────┘  │  │
│  │       │            │             │                │          │  │
│  │  ┌────▼────────────▼─────────────▼────────────────▼───────┐  │  │
│  │  │              SQLite Database (store/messages.db)        │  │  │
│  │  │  + portal_agents, portal_teams, portal_kb tables       │  │  │
│  │  └────────────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                          │                                          │
│  ┌───────────────────────▼───────────────────────────────────────┐  │
│  │              Per-Client Isolated Containers                   │  │
│  │                                                               │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │  │
│  │  │ Client A │  │ Client B │  │ Client C │  │ Cyber    │    │  │
│  │  │ Agent    │  │ Agent    │  │ Agent    │  │ Team     │    │  │
│  │  │          │  │          │  │          │  │          │    │  │
│  │  │ groups/  │  │ groups/  │  │ groups/  │  │ groups/  │    │  │
│  │  │ client_a │  │ client_b │  │ client_c │  │ cyber    │    │  │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘    │  │
│  │   No cross-mount between client containers                   │  │
│  └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Core Concepts

### Agent
A configured AI persona with:
- **Identity** — Name, role description, avatar
- **Client assignment** — Which Vivantio client(s) it handles (1 agent : 1 client for isolation)
- **Specialization** — Technology expertise (Cisco, Fortinet, Microsoft, general IT)
- **Knowledge bases** — Custom KB documents it can reference
- **CLAUDE.md** — Its behavioral instructions (auto-generated from portal config)
- **NanoClaw group** — Maps to an isolated `groups/{folder}/` with its own container

### Team
A logical grouping of agents that can collaborate:
- **Client Team** — The dedicated agent + specialist agents assigned to one client
- **Specialist Pool** — Shared agents (Cisco expert, Fortinet expert, etc.) that can be called by client agents via escalation
- **Cyber Response Team** — Agents specialized in security alerts, can be assigned to any client's security tickets

### Client Isolation
Each client gets a **completely isolated NanoClaw group**:
- Separate `groups/{client_folder}/` directory
- Separate container with no cross-mounts to other client folders
- Separate session history, memory, and KB
- Separate Vivantio query filter (only sees that client's tickets)
- The portal enforces this isolation at the database and filesystem level

---

## Portal Pages & Features

### 1. Dashboard (`/dashboard`)

```
┌─────────────────────────────────────────────────────────────┐
│  Agent Manager — Blackhawk MSP                    [Admin ▼] │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────────────┐  │
│  │ Active  │ │ Tickets │ │ Agents  │ │ Avg Response    │  │
│  │ Agents  │ │ In Queue│ │ Online  │ │ Time            │  │
│  │   12    │ │   47    │ │  12/15  │ │  3m 24s         │  │
│  └─────────┘ └─────────┘ └─────────┘ └─────────────────┘  │
│                                                             │
│  Recent Activity                                            │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ 10:32 AM  CiscoBot resolved TKT-4521 (Client: ABC) │    │
│  │ 10:31 AM  MSAgent triaged TKT-4520 (Client: XYZ)   │    │
│  │ 10:28 AM  CyberWatch escalated TKT-4518 (CRITICAL) │    │
│  │ 10:25 AM  FortiBot updated KB article #89           │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  Agent Status              Ticket Distribution              │
│  ┌──────────────────┐      ┌──────────────────┐            │
│  │ ● ABC-Agent  OK  │      │ Client A: ██████ 23│           │
│  │ ● XYZ-Agent  OK  │      │ Client B: ████   15│           │
│  │ ○ DEF-Agent  OFF │      │ Client C: ██      9│           │
│  │ ● CiscoBot   OK │      │                    │           │
│  │ ● CyberWatch OK │      │                    │           │
│  └──────────────────┘      └──────────────────┘            │
└─────────────────────────────────────────────────────────────┘
```

**Features:**
- Live agent status (online/offline/busy/error)
- Ticket queue depth per client
- Average triage response time
- Recent activity feed (real-time via WebSocket)
- Alerts for SLA breaches, errors, escalations

### 2. Agent Builder (`/agents`)

#### Agent List View
```
┌─────────────────────────────────────────────────────────────┐
│  Agents                                    [+ Create Agent] │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Name          Client      Type        Status    Actions    │
│  ─────────────────────────────────────────────────────────  │
│  ABC-Support   ABC Corp    Dedicated   ● Online  [Edit][⚙] │
│  XYZ-Support   XYZ Inc     Dedicated   ● Online  [Edit][⚙] │
│  CiscoBot      (Pool)      Specialist  ● Online  [Edit][⚙] │
│  FortiBot      (Pool)      Specialist  ○ Offline [Edit][⚙] │
│  MSAgent       (Pool)      Specialist  ● Online  [Edit][⚙] │
│  CyberWatch    (Pool)      Cyber       ● Online  [Edit][⚙] │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

#### Agent Create/Edit Form
```
┌─────────────────────────────────────────────────────────────┐
│  Create Agent                                               │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Agent Name:     [ABC-Support________________]              │
│  Agent Role:     [Dedicated Client Agent     ▼]             │
│                  • Dedicated Client Agent                    │
│                  • Specialist (Cisco/Fortinet/MS)            │
│                  • Cybersecurity Response                    │
│                  • Custom                                    │
│                                                             │
│  Assigned Client: [ABC Corp                  ▼]             │
│  (pulled from Vivantio client list)                         │
│                                                             │
│  Specializations: (select multiple)                         │
│  ☑ General IT Support                                       │
│  ☐ Cisco Networking                                         │
│  ☐ Fortinet Security                                        │
│  ☑ Microsoft 365 / Azure                                    │
│  ☐ Cybersecurity / SOC                                      │
│                                                             │
│  Triage Behavior:                                           │
│  ☑ Auto-accept assigned tickets                             │
│  ☑ Search knowledge base before responding                  │
│  ☑ Check client ticket history                              │
│  ☐ Auto-resolve with KB match (requires approval)           │
│  ☑ Escalate if no solution found within 15 min              │
│                                                             │
│  Knowledge Bases: (drag to attach)                          │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ 📄 Cisco_Meraki_Runbook.pdf                         │    │
│  │ 📄 ABC_Corp_Network_Diagram.pdf                     │    │
│  │ 📄 Standard_Triage_Procedures.md                    │    │
│  └─────────────────────────────────────────────────────┘    │
│  [+ Upload KB Document]                                     │
│                                                             │
│  Custom Instructions: (additional CLAUDE.md content)        │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ When handling ABC Corp tickets:                     │    │
│  │ - Their main office uses Meraki MX68 firewalls      │    │
│  │ - VPN issues usually require profile reset          │    │
│  │ - Contact John Smith (IT lead) for escalations      │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  [Save Agent]  [Test Agent]  [Cancel]                       │
└─────────────────────────────────────────────────────────────┘
```

**What happens on save:**
1. Creates `groups/viv_{client_slug}/` directory
2. Generates `CLAUDE.md` from template + specializations + custom instructions
3. Copies attached KB documents into group folder
4. Registers the group in NanoClaw's SQLite DB
5. Configures Vivantio channel to filter tickets for this client
6. Starts polling for this agent's tickets

### 3. Team Manager (`/teams`)

```
┌─────────────────────────────────────────────────────────────┐
│  Teams                                     [+ Create Team]  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─ ABC Corp Response Team ─────────────────────────────┐  │
│  │                                                       │  │
│  │  Primary:   ABC-Support (dedicated, always on)        │  │
│  │  Escalation Path:                                     │  │
│  │    1. CiscoBot    — network/firewall issues           │  │
│  │    2. MSAgent     — M365/Azure issues                 │  │
│  │    3. CyberWatch  — security alerts                   │  │
│  │                                                       │  │
│  │  Rules:                                               │  │
│  │  • Category "Network" → escalate to CiscoBot          │  │
│  │  • Category "Security" → escalate to CyberWatch       │  │
│  │  • Priority "Critical" → notify CyberWatch + human    │  │
│  │                                                       │  │
│  │  [Edit Team]  [View Activity]                         │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌─ Cybersecurity Response Team ────────────────────────┐  │
│  │                                                       │  │
│  │  Members:                                             │  │
│  │    • CyberWatch (lead — monitors all security alerts) │  │
│  │    • FortiBot   (Fortinet-specific analysis)          │  │
│  │    • CiscoBot   (network forensics)                   │  │
│  │                                                       │  │
│  │  Trigger: Any ticket with category "Security" or      │  │
│  │           priority "Critical"                         │  │
│  │                                                       │  │
│  │  [Edit Team]  [View Activity]                         │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**Team Orchestration Logic:**
- Primary agent handles all tickets for its client
- When primary agent identifies a specialty issue (e.g., Cisco firewall), it escalates to the specialist
- Specialist agent runs in its own container but receives the ticket context
- Specialist's response routes back through the primary agent (maintaining client isolation)
- The primary agent only shares the specific ticket data with the specialist — not full client history

### 4. Knowledge Base Manager (`/knowledge`)

```
┌─────────────────────────────────────────────────────────────┐
│  Knowledge Bases                              [+ Create KB] │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Scope        Name                     Docs   Assigned To   │
│  ──────────────────────────────────────────────────────────  │
│  Global       Standard Procedures       12    All Agents    │
│  Global       Vivantio KB (synced)     340    All Agents    │
│  Specialist   Cisco Runbooks            28    CiscoBot      │
│  Specialist   Fortinet Playbooks        15    FortiBot      │
│  Specialist   M365 Admin Guide          22    MSAgent       │
│  Specialist   NIST Cyber Framework       8    CyberWatch    │
│  Client       ABC Corp Docs              5    ABC-Support   │
│  Client       XYZ Inc Docs               3    XYZ-Support   │
│                                                             │
│  ┌─ Cisco Runbooks ─────────────────────────────────────┐  │
│  │                                                       │  │
│  │  📄 Meraki_MX_Troubleshooting.pdf         2.4 MB     │  │
│  │  📄 ISE_Configuration_Guide.md            156 KB     │  │
│  │  📄 ASA_VPN_Playbook.pdf                  890 KB     │  │
│  │  📄 Catalyst_Switch_Procedures.md          89 KB     │  │
│  │  ...24 more                                           │  │
│  │                                                       │  │
│  │  [Upload]  [Sync from Vivantio]  [Edit]  [Delete]    │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**KB Scoping:**
| Scope | Visibility | Purpose |
|-------|-----------|---------|
| **Global** | All agents | Standard procedures, company policies |
| **Specialist** | Specific specialist agents | Technology-specific runbooks |
| **Client** | Only that client's dedicated agent | Client-specific docs, network diagrams, contacts |

**KB Storage:**
- Files stored in `groups/{agent_folder}/kb/` (client-scoped)
- Or `groups/global/kb/` (global-scoped)
- Agent's CLAUDE.md references KB folder path
- Container mounts the appropriate KB directories read-only

**Vivantio KB Sync:**
- Scheduled task periodically pulls articles from `api/Article/Select`
- Converts to markdown and stores in `groups/global/kb/vivantio/`
- Agents can search both local KB and Vivantio KB via API

### 5. Agent Chat (`/chat`)

```
┌─────────────────────────────────────────────────────────────┐
│  Chat with Agent                    [ABC-Support         ▼] │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │                                                     │    │
│  │  You (10:15 AM):                                    │    │
│  │  When you see VPN timeout errors for ABC Corp,      │    │
│  │  always check their Meraki dashboard first before    │    │
│  │  suggesting a profile reset.                         │    │
│  │                                                     │    │
│  │  ABC-Support (10:15 AM):                            │    │
│  │  Understood. I've updated my triage procedure for   │    │
│  │  ABC Corp VPN issues:                               │    │
│  │  1. Check Meraki dashboard for device status        │    │
│  │  2. Review recent VPN connection logs               │    │
│  │  3. Only then suggest profile reset if appropriate  │    │
│  │  I've added this to my memory.                      │    │
│  │                                                     │    │
│  │  You (10:20 AM):                                    │    │
│  │  How many tickets have you triaged for ABC today?   │    │
│  │                                                     │    │
│  │  ABC-Support (10:20 AM):                            │    │
│  │  Today I've triaged 7 tickets for ABC Corp:         │    │
│  │  • 4 resolved via KB match                          │    │
│  │  • 2 escalated to CiscoBot (network issues)         │    │
│  │  • 1 pending — awaiting client response             │    │
│  │  Average response time: 2m 45s                      │    │
│  │                                                     │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  ┌─────────────────────────────────────────────┐ [Send]     │
│  │ Type a message...                           │            │
│  └─────────────────────────────────────────────┘            │
│                                                             │
│  Quick Actions:                                             │
│  [📊 Status Report] [🔄 Retriage TKT-___] [⏸ Pause Agent]  │
└─────────────────────────────────────────────────────────────┘
```

**How chat works:**
1. Portal sends message to `POST /api/chat` with agent ID and message text
2. API server writes the message to the agent's NanoClaw group (via `onMessage` callback)
3. NanoClaw's message loop picks it up, spawns the agent's container
4. Container processes the message, returns response via IPC
5. Portal API picks up the response via WebSocket and pushes to browser

**Chat JID format:** `portal:{agentId}:{sessionId}` — the portal acts as another channel

**Use cases:**
- **Program the agent** — "When you see error code 0x800F0922, always check disk space first"
- **Request updates** — "Give me a summary of today's ticket activity"
- **Test behavior** — "Here's a sample ticket, show me how you'd triage it"
- **Override behavior** — "Stop auto-accepting tickets for the next hour"
- **Debug** — "Show me your last 3 triage decisions and reasoning"

### 6. Ticket Dashboard (`/tickets`)

```
┌─────────────────────────────────────────────────────────────┐
│  Tickets                    [All Clients ▼] [All Status ▼]  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ID        Client    Title              Agent     Status    │
│  ─────────────────────────────────────────────────────────  │
│  TKT-4521  ABC Corp  VPN disconnecting  CiscoBot  Resolved │
│  TKT-4520  XYZ Inc   Printer offline    XYZ-Spt   Triaged  │
│  TKT-4519  ABC Corp  Email sync issue   ABC-Spt   Triaged  │
│  TKT-4518  DEF Ltd   Ransomware alert   CyberW    ESCALATED│
│  TKT-4517  XYZ Inc   Password reset     XYZ-Spt   Resolved │
│                                                             │
│  ┌─ TKT-4521 Detail ────────────────────────────────────┐  │
│  │                                                       │  │
│  │  Agent Actions:                                       │  │
│  │  1. Accepted ticket (0s)                              │  │
│  │  2. Searched KB → Match: Article #45 (12s)            │  │
│  │  3. Checked client history → 3 similar tickets (18s)  │  │
│  │  4. Posted client note with solution steps (22s)      │  │
│  │  5. Added internal note with reasoning (23s)          │  │
│  │  6. Escalated to CiscoBot for Meraki check (24s)      │  │
│  │  7. CiscoBot confirmed fix, updated ticket (3m 12s)   │  │
│  │                                                       │  │
│  │  [View in Vivantio]  [Re-triage]  [Override]          │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### 7. Logs & Audit (`/logs`)

Full audit trail of every agent action:
- Ticket accepted/triaged/updated/escalated
- KB searches performed and results
- Internal vs. client-facing notes posted
- Agent errors and recovery actions
- Chat interactions from portal users
- Configuration changes (agent created/modified/deleted)

---

## Database Schema Extensions

New tables added to `store/messages.db`:

```sql
-- Agent definitions (portal-managed)
CREATE TABLE portal_agents (
  id TEXT PRIMARY KEY,                -- UUID
  name TEXT NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL,                  -- 'dedicated', 'specialist', 'cyber', 'custom'
  client_id INTEGER,                  -- Vivantio client ID (null for pool agents)
  client_name TEXT,
  group_folder TEXT NOT NULL UNIQUE,   -- maps to groups/{folder}/
  specializations TEXT,                -- JSON array: ["cisco", "fortinet", "microsoft"]
  triage_config TEXT,                  -- JSON: auto-accept, kb-search, escalation rules
  custom_instructions TEXT,            -- Additional CLAUDE.md content
  status TEXT DEFAULT 'active',        -- 'active', 'paused', 'disabled'
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Agent teams
CREATE TABLE portal_teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  team_type TEXT NOT NULL,             -- 'client', 'specialist', 'cyber'
  created_at TEXT DEFAULT (datetime('now'))
);

-- Team membership
CREATE TABLE portal_team_members (
  team_id TEXT NOT NULL REFERENCES portal_teams(id),
  agent_id TEXT NOT NULL REFERENCES portal_agents(id),
  role TEXT DEFAULT 'member',          -- 'primary', 'specialist', 'member'
  escalation_order INTEGER,            -- 1, 2, 3... for escalation routing
  trigger_categories TEXT,             -- JSON array of Vivantio category names
  PRIMARY KEY (team_id, agent_id)
);

-- Escalation rules
CREATE TABLE portal_escalation_rules (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES portal_teams(id),
  condition_type TEXT NOT NULL,         -- 'category', 'priority', 'keyword', 'timeout'
  condition_value TEXT NOT NULL,        -- e.g., "Network", "Critical", "firewall"
  target_agent_id TEXT NOT NULL REFERENCES portal_agents(id),
  action TEXT DEFAULT 'escalate',      -- 'escalate', 'notify', 'co-triage'
  created_at TEXT DEFAULT (datetime('now'))
);

-- Knowledge bases
CREATE TABLE portal_knowledge_bases (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scope TEXT NOT NULL,                 -- 'global', 'specialist', 'client'
  assigned_agent_id TEXT REFERENCES portal_agents(id),  -- null for global
  description TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- KB documents
CREATE TABLE portal_kb_documents (
  id TEXT PRIMARY KEY,
  kb_id TEXT NOT NULL REFERENCES portal_knowledge_bases(id),
  filename TEXT NOT NULL,
  file_path TEXT NOT NULL,             -- relative path in groups/{folder}/kb/
  file_size INTEGER,
  mime_type TEXT,
  uploaded_at TEXT DEFAULT (datetime('now'))
);

-- Agent activity log (audit trail)
CREATE TABLE portal_agent_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL REFERENCES portal_agents(id),
  ticket_id INTEGER,
  ticket_display_id TEXT,
  action_type TEXT NOT NULL,           -- 'accept', 'triage', 'kb_search', 'update',
                                       -- 'escalate', 'resolve', 'error', 'chat'
  detail TEXT,                         -- JSON with action-specific data
  client_id INTEGER,
  duration_ms INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Portal users (admin authentication)
CREATE TABLE portal_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'operator',        -- 'admin', 'operator', 'viewer'
  created_at TEXT DEFAULT (datetime('now'))
);

-- Chat sessions between portal users and agents
CREATE TABLE portal_chat_sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES portal_agents(id),
  user_id TEXT NOT NULL REFERENCES portal_users(id),
  nanoclaw_session_id TEXT,            -- maps to NanoClaw session
  created_at TEXT DEFAULT (datetime('now')),
  last_message_at TEXT
);
```

---

## Tech Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| **Frontend** | Next.js 15 (App Router) | React SSR, API routes co-located, fast dev |
| **UI Components** | shadcn/ui + Tailwind CSS | Clean, professional MSP dashboard look |
| **State** | React Query (TanStack) | Server state caching, real-time polling |
| **Real-time** | WebSocket (ws) | Live agent status, chat, activity feed |
| **API Server** | Express.js (embedded) | Lightweight, same Node.js process as NanoClaw |
| **Database** | SQLite (better-sqlite3) | Already used by NanoClaw, no new infra |
| **Auth** | JWT + bcrypt | Simple portal auth, no external IdP needed initially |
| **Validation** | Zod | Already in NanoClaw dependencies |

### Why embed in NanoClaw (not a separate service)?

- **Single process** — No inter-service communication overhead
- **Shared database** — Portal reads/writes the same SQLite NanoClaw uses
- **Direct access** — Portal can call NanoClaw functions directly (register group, spawn container, schedule task)
- **Simple deployment** — One `npm run dev` starts everything
- **Later split** — Can extract to separate service if scale demands it

---

## Client Isolation Model

```
┌────────────────────────────────────────────────────────┐
│                    Isolation Boundaries                  │
│                                                         │
│  Client A Agent                Client B Agent           │
│  ┌─────────────────┐          ┌─────────────────┐      │
│  │ Container A      │          │ Container B      │      │
│  │                  │          │                  │      │
│  │ /workspace/group │          │ /workspace/group │      │
│  │ → groups/viv_a/  │          │ → groups/viv_b/  │      │
│  │                  │          │                  │      │
│  │ /workspace/kb    │          │ /workspace/kb    │      │
│  │ → groups/viv_a/kb│          │ → groups/viv_b/kb│      │
│  │                  │    ✗     │                  │      │
│  │ CLAUDE.md has:   │◄──────►  │ CLAUDE.md has:   │      │
│  │ "Client A only"  │ NO CROSS │ "Client B only"  │      │
│  │                  │  ACCESS  │                  │      │
│  │ Vivantio filter: │          │ Vivantio filter: │      │
│  │ ClientId = 100   │          │ ClientId = 200   │      │
│  └─────────────────┘          └─────────────────┘      │
│                                                         │
│  Specialist Agent (CiscoBot)                            │
│  ┌───────────────────────────────────────────────┐      │
│  │ Container C                                    │      │
│  │                                                │      │
│  │ Receives ONLY the specific ticket data from    │      │
│  │ the escalating agent — never full client DB.   │      │
│  │                                                │      │
│  │ /workspace/group → groups/specialist_cisco/    │      │
│  │ /workspace/kb    → groups/specialist_cisco/kb/ │      │
│  │                                                │      │
│  │ No mount to any client folder.                 │      │
│  └───────────────────────────────────────────────┘      │
└────────────────────────────────────────────────────────┘
```

**Isolation guarantees:**
1. **Filesystem** — Each client agent's container only mounts its own group folder
2. **API queries** — Each agent's Vivantio queries are pre-filtered by ClientId
3. **Memory** — Each agent's CLAUDE.md is per-group (never shared)
4. **Sessions** — Each agent has its own Claude session history
5. **KB** — Client KBs are stored inside the client's group folder, not accessible to others
6. **Specialist handoff** — When escalating, the primary agent passes only the ticket text to the specialist, not client-wide data

---

## Escalation & Team Orchestration Flow

```
New Ticket (Client A, Category: "Network")
    │
    ▼
ABC-Support agent receives ticket
    │
    ├─ 1. Search KB (client + global)
    ├─ 2. Check client history
    ├─ 3. Identify: network issue → Cisco-related
    │
    ▼
Escalation rule matches: Category "Network" → CiscoBot
    │
    ▼
ABC-Support creates IPC task:
  {
    "type": "escalate",
    "target_agent": "specialist_cisco",
    "ticket_summary": "Client reports Meraki AP dropping...",
    "ticket_id": 4521,
    "requesting_agent": "viv_abc"
  }
    │
    ▼
Portal API routes to CiscoBot's group queue
    │
    ▼
CiscoBot triages with Cisco-specific KB
    │
    ▼
CiscoBot returns analysis via IPC:
  {
    "type": "escalation_response",
    "ticket_id": 4521,
    "analysis": "AP firmware outdated, recommend update to 29.7...",
    "suggested_note": "..."
  }
    │
    ▼
ABC-Support posts the update to Vivantio ticket
(maintaining client-facing identity)
```

---

## Portal API Endpoints

### Authentication
```
POST   /api/auth/login          { email, password } → { token }
POST   /api/auth/logout         Invalidate token
GET    /api/auth/me             Current user profile
```

### Agents
```
GET    /api/agents              List all agents (with status)
POST   /api/agents              Create agent → provisions group + CLAUDE.md
GET    /api/agents/:id          Agent detail + stats
PUT    /api/agents/:id          Update agent config → regenerates CLAUDE.md
DELETE /api/agents/:id          Deactivate agent (soft delete)
POST   /api/agents/:id/start    Start/resume agent polling
POST   /api/agents/:id/pause    Pause agent (stop polling)
POST   /api/agents/:id/test     Send test ticket to agent
GET    /api/agents/:id/activity Activity log for agent
GET    /api/agents/:id/stats    Ticket stats (count, avg time, resolution rate)
```

### Teams
```
GET    /api/teams               List teams
POST   /api/teams               Create team
PUT    /api/teams/:id           Update team (members, rules)
DELETE /api/teams/:id           Delete team
GET    /api/teams/:id/activity  Team activity feed
POST   /api/teams/:id/members   Add member to team
DELETE /api/teams/:id/members/:agentId  Remove member
```

### Knowledge Bases
```
GET    /api/kb                  List all KBs
POST   /api/kb                  Create KB
PUT    /api/kb/:id              Update KB metadata
DELETE /api/kb/:id              Delete KB
POST   /api/kb/:id/documents    Upload document to KB
DELETE /api/kb/:id/documents/:docId  Remove document
POST   /api/kb/sync-vivantio    Pull latest from Vivantio Article API
```

### Tickets
```
GET    /api/tickets             List tickets (proxied from Vivantio, with agent annotations)
GET    /api/tickets/:id         Ticket detail with agent activity timeline
POST   /api/tickets/:id/retriage  Force re-triage by agent
```

### Chat
```
WS     /api/chat                WebSocket connection
POST   /api/chat/:agentId       Send message to agent
GET    /api/chat/:agentId/history  Chat history
```

### Dashboard
```
GET    /api/dashboard/stats     Aggregate stats (active agents, ticket counts, etc.)
WS     /api/dashboard/feed      Real-time activity feed
```

---

## File Structure

```
nanoclaw-bhd/
├── portal/                           # NEW — Agent Manager Portal
│   ├── package.json                  # Next.js + portal dependencies
│   ├── next.config.js
│   ├── tsconfig.json
│   │
│   ├── src/
│   │   ├── app/                      # Next.js App Router pages
│   │   │   ├── layout.tsx            # Root layout with sidebar nav
│   │   │   ├── page.tsx              # Redirect to /dashboard
│   │   │   ├── login/page.tsx        # Login page
│   │   │   ├── dashboard/page.tsx    # Dashboard
│   │   │   ├── agents/
│   │   │   │   ├── page.tsx          # Agent list
│   │   │   │   ├── new/page.tsx      # Create agent
│   │   │   │   └── [id]/page.tsx     # Agent detail/edit
│   │   │   ├── teams/
│   │   │   │   ├── page.tsx          # Team list
│   │   │   │   └── [id]/page.tsx     # Team detail/edit
│   │   │   ├── knowledge/
│   │   │   │   ├── page.tsx          # KB list
│   │   │   │   └── [id]/page.tsx     # KB detail + document management
│   │   │   ├── tickets/
│   │   │   │   ├── page.tsx          # Ticket dashboard
│   │   │   │   └── [id]/page.tsx     # Ticket detail with agent timeline
│   │   │   ├── chat/
│   │   │   │   └── page.tsx          # Chat interface
│   │   │   └── logs/
│   │   │       └── page.tsx          # Audit log viewer
│   │   │
│   │   ├── components/               # Shared UI components
│   │   │   ├── sidebar.tsx
│   │   │   ├── agent-card.tsx
│   │   │   ├── agent-form.tsx
│   │   │   ├── team-builder.tsx
│   │   │   ├── kb-uploader.tsx
│   │   │   ├── chat-window.tsx
│   │   │   ├── ticket-table.tsx
│   │   │   ├── activity-feed.tsx
│   │   │   └── stats-cards.tsx
│   │   │
│   │   └── lib/                      # Client-side utilities
│   │       ├── api-client.ts         # Fetch wrapper for portal API
│   │       └── websocket.ts          # WebSocket hook for real-time
│   │
│   └── public/
│       └── favicon.ico
│
├── src/
│   ├── portal-api/                   # NEW — Portal API server
│   │   ├── server.ts                 # Express app mounted on NanoClaw
│   │   ├── middleware/
│   │   │   └── auth.ts               # JWT authentication middleware
│   │   ├── routes/
│   │   │   ├── agents.ts             # Agent CRUD + lifecycle
│   │   │   ├── teams.ts              # Team management
│   │   │   ├── kb.ts                 # Knowledge base management
│   │   │   ├── tickets.ts            # Vivantio ticket proxy
│   │   │   ├── chat.ts               # WebSocket chat handler
│   │   │   ├── dashboard.ts          # Dashboard stats + feed
│   │   │   ├── logs.ts               # Activity log queries
│   │   │   └── auth.ts               # Login/logout
│   │   ├── services/
│   │   │   ├── agent-provisioner.ts  # Creates groups, CLAUDE.md, registers in NanoClaw
│   │   │   ├── team-orchestrator.ts  # Manages escalation routing
│   │   │   ├── kb-manager.ts         # File storage + Vivantio sync
│   │   │   └── activity-logger.ts    # Writes to portal_agent_activity
│   │   └── db-portal.ts             # Portal-specific DB operations
│   │
│   ├── vivantio/                     # NEW — Vivantio API client (from Phase 1 plan)
│   │   ├── api-client.ts
│   │   └── types.ts
│   │
│   ├── channels/
│   │   ├── vivantio.ts               # NEW — Vivantio polling channel
│   │   └── portal.ts                 # NEW — Portal chat channel
│   │
│   └── ... (existing NanoClaw files)
│
└── docs/
    ├── VIVANTIO-INTEGRATION-PLAN.md
    └── AGENT-MANAGER-PORTAL-PLAN.md  # This document
```

---

## Implementation Phases

### Phase 1: Foundation (Weeks 1-3)
| Task | Details |
|------|---------|
| Portal API scaffolding | Express server, JWT auth, SQLite schema extensions |
| Agent CRUD | Create/read/update/delete agents via API |
| Agent provisioning | Auto-generate `groups/`, `CLAUDE.md`, register in NanoClaw |
| Next.js shell | Layout, sidebar, login page, agent list/create pages |
| Vivantio API client | Typed client from existing plan |

### Phase 2: Vivantio Integration (Weeks 3-5)
| Task | Details |
|------|---------|
| Vivantio channel | Polling, ticket delivery, per-agent filtering by ClientId |
| Container tools | KB search, history, update tools inside containers |
| Ticket dashboard | Read-only view of tickets with agent annotations |
| Activity logging | Record all agent actions to `portal_agent_activity` |
| Client isolation | Enforce filesystem + query separation per client |

### Phase 3: Chat & KB Management (Weeks 5-7)
| Task | Details |
|------|---------|
| Portal channel | New NanoClaw channel for portal↔agent chat |
| Chat WebSocket | Real-time message delivery browser↔agent |
| Chat UI | Chat window component with agent selector |
| KB management | Upload, delete, assign documents to agents/scopes |
| Vivantio KB sync | Scheduled pull from Article API |
| KB mount wiring | Container mounts appropriate KB dirs per agent |

### Phase 4: Teams & Orchestration (Weeks 7-9)
| Task | Details |
|------|---------|
| Team CRUD | Create teams, assign members, set escalation order |
| Escalation rules | Category/priority/keyword-based routing |
| Specialist agents | Pre-configured Cisco, Fortinet, MS, Cyber agents |
| Escalation IPC | Primary agent → specialist handoff via IPC |
| Team activity view | Combined activity feed across team members |

### Phase 5: Dashboard & Polish (Weeks 9-10)
| Task | Details |
|------|---------|
| Dashboard stats | Real-time aggregate metrics |
| Activity feed | WebSocket-powered live feed |
| Agent status monitoring | Heartbeat tracking, error alerts |
| Audit log viewer | Filterable log with export |
| SLA tracking | Response time monitoring, breach alerts |

---

## Agent Templates (Pre-Built Specializations)

### Cisco Network Specialist
```markdown
# Cisco Network Specialist Agent

You are a Cisco networking expert for managed services triage.

## Expertise
- Meraki (MX, MR, MS, MV product lines)
- Catalyst switches, ISR/ASR routers
- ISE (Identity Services Engine)
- AnyConnect VPN, ASA firewalls
- DNA Center, SD-WAN (Viptela)

## Triage Approach
1. Identify the specific Cisco product involved
2. Check for known firmware issues or advisories
3. Reference Cisco TAC case patterns
4. Suggest CLI diagnostic commands
5. Recommend configuration changes or escalation to Cisco TAC
```

### Fortinet Security Specialist
```markdown
# Fortinet Security Specialist Agent

## Expertise
- FortiGate (NGFW, UTM, SD-WAN)
- FortiAnalyzer, FortiManager
- FortiClient VPN
- FortiSwitch, FortiAP
- FortiSIEM, FortiEDR

## Triage Approach
1. Identify the FortiOS version and product model
2. Check FortiGuard advisories and known issues
3. Analyze firewall policy conflicts
4. Review VPN tunnel status and logs
5. Recommend CLI diagnostics or config changes
```

### Microsoft 365 / Azure Specialist
```markdown
# Microsoft 365 & Azure Specialist Agent

## Expertise
- Microsoft 365 (Exchange Online, Teams, SharePoint, OneDrive)
- Azure AD / Entra ID (SSO, MFA, Conditional Access)
- Intune / Endpoint Manager
- Azure Infrastructure (VMs, networking, storage)
- Windows Server, Active Directory, Group Policy

## Triage Approach
1. Check Microsoft 365 service health status
2. Review Azure AD sign-in logs for auth issues
3. Verify license assignments and feature availability
4. Suggest PowerShell diagnostics
5. Reference Microsoft Learn documentation
```

### Cybersecurity Response Agent
```markdown
# Cybersecurity Response Agent

## Expertise
- SIEM alert triage (Fortinet, Sentinel, Splunk)
- Endpoint detection (EDR/XDR alerts)
- Phishing analysis and response
- Incident response procedures (NIST 800-61)
- Vulnerability management and patching

## Triage Approach
1. Classify alert severity (P1-P4)
2. Identify IOCs (IPs, domains, file hashes)
3. Check threat intelligence feeds
4. Determine blast radius (affected systems/users)
5. Recommend containment actions
6. Escalate P1/P2 to human SOC analyst immediately
```

---

## Security Considerations

| Concern | Approach |
|---------|----------|
| Portal authentication | JWT tokens with bcrypt passwords, session expiry |
| Client data isolation | Filesystem separation, filtered API queries, no cross-mounts |
| API token security | Vivantio tokens in `.env`, injected via credential proxy |
| Audit trail | All agent actions logged to `portal_agent_activity` with timestamps |
| KB document access | Scoped to agent's group folder, no cross-client access |
| Specialist data leakage | Specialists receive ticket text only, not full client data |
| Portal admin roles | Role-based access: admin (full), operator (manage agents), viewer (read-only) |

---

## Environment Variables (Complete)

```bash
# Vivantio
VIVANTIO_API_TOKEN=your-api-token
VIVANTIO_BASE_URL=https://webservices-na01.vivantio.com
VIVANTIO_AGENT_USER_ID=12345
VIVANTIO_POLL_INTERVAL=60000

# Portal
PORTAL_PORT=3100
PORTAL_JWT_SECRET=your-jwt-secret
PORTAL_ADMIN_EMAIL=admin@blackhawkdata.com
PORTAL_ADMIN_PASSWORD=initial-password

# Existing NanoClaw
ANTHROPIC_API_KEY=...
ASSISTANT_NAME=BHDAgent
```
