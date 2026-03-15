# Vivantio ITSM Integration Plan — Blackhawk Managed Services Agent

## Executive Summary

This plan describes how to integrate NanoClaw with Vivantio ITSM so an AI agent acts as a **live technician** inside Blackhawk's ticketing system. The agent will poll for new tickets, triage them using knowledge base lookups and historical ticket analysis, and update tickets with findings — all autonomously.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                    NanoClaw Host                     │
│                                                     │
│  ┌─────────────┐    ┌──────────────────────────┐    │
│  │  Vivantio    │    │  Container (Claude Agent) │    │
│  │  Channel     │───▶│                          │    │
│  │  (Poller)    │◀───│  - vivantio-api tool     │    │
│  │              │    │  - KB search tool        │    │
│  │  Polls every │    │  - ticket history tool   │    │
│  │  60s for new │    │  - ticket update tool    │    │
│  │  tickets     │    │                          │    │
│  └─────────────┘    └──────────────────────────┘    │
│         │                       │                    │
│         ▼                       ▼ (IPC)              │
│  ┌─────────────┐    ┌──────────────────────────┐    │
│  │  SQLite DB   │    │  Vivantio REST API       │    │
│  │  (messages,  │    │  (via credential proxy)  │    │
│  │   tickets)   │    │                          │    │
│  └─────────────┘    └──────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

### Two-Part Design

The integration has two complementary components:

1. **Vivantio Channel** (`src/channels/vivantio.ts`) — A polling-based channel that checks Vivantio for new/updated tickets assigned to the agent, converts them into NanoClaw messages, and routes responses back as ticket updates.

2. **Vivantio MCP Tools** (container skill) — Tools available inside the agent container that let Claude directly query the Vivantio API for KB articles, historical tickets, client info, and post updates.

---

## Phase 1: Core Ticket Triage Agent

### 1.1 Vivantio API Client Library

**File:** `src/vivantio/api-client.ts`

A typed API client wrapping Vivantio's REST API:

```typescript
interface VivantioConfig {
  baseUrl: string;        // https://webservices-na01.vivantio.com
  apiToken: string;       // Bearer token from .env
  agentUserId: number;    // The Vivantio user ID the agent impersonates
}

class VivantioClient {
  // Ticket operations
  async selectTickets(query: SelectQuery): Promise<Ticket[]>;
  async selectTicketById(id: number): Promise<Ticket>;
  async selectTicketByDisplayId(displayId: string): Promise<Ticket>;
  async selectTicketsPage(page: number, pageSize: number, query: SelectQuery): Promise<PageResult<Ticket>>;
  async updateTicket(request: TicketUpdateRequest): Promise<ActionResponse>;
  async addNote(request: AddNoteRequest): Promise<ActionResponse>;
  async acceptTicket(ticketId: number): Promise<ActionResponse>;
  async changeStatus(ticketIds: number[], statusId: number): Promise<ActionResponse>;
  async changeOwner(ticketIds: number[], ownerId: number): Promise<ActionResponse>;
  async getTicketActions(ticketId: number): Promise<TicketAction[]>;

  // Knowledge Base
  async searchArticles(query: SelectQuery): Promise<Article[]>;
  async getArticleById(id: number): Promise<Article>;

  // Client/Caller
  async selectClients(query: SelectQuery): Promise<Client[]>;
  async getClientById(id: number): Promise<Client>;
  async selectCallers(query: SelectQuery): Promise<Caller[]>;

  // Assets
  async selectAssets(query: SelectQuery): Promise<Asset[]>;
  async getAssetById(id: number): Promise<Asset>;
  async getLinkedAssets(assetId: number): Promise<Asset[]>;

  // Configuration
  async getTicketTypes(): Promise<TicketType[]>;
  async getStatuses(recordTypeId: number): Promise<Status[]>;
  async getPriorities(recordTypeId: number): Promise<Priority[]>;
  async getCategories(recordTypeId: number): Promise<Category[]>;
  async getUsers(): Promise<User[]>;
  async getGroups(): Promise<Group[]>;
}
```

**Query structure** (based on API docs):
```typescript
interface SelectQuery {
  Mode: number;     // 0 = MatchAll, 1 = MatchAny (needs verification)
  Items: QueryItem[] | null;
}

interface QueryItem {
  FieldName: string;
  Operator: string;   // "Equals", "Contains", "GreaterThan", etc.
  Value: string | number;
}
```

**Authentication:** All requests include header `Authorization: Bearer {VIVANTIO_API_TOKEN}`. The token is stored in `.env` and injected via the credential proxy.

### 1.2 Vivantio Channel (Polling)

**File:** `src/channels/vivantio.ts`

The channel polls Vivantio for new tickets assigned to the agent user, then delivers them as NanoClaw messages.

```typescript
class VivantioChannel implements Channel {
  name = 'vivantio';
  private pollInterval = 60_000;  // 60 seconds
  private client: VivantioClient;
  private lastPollTime: string;   // ISO timestamp

  async connect() {
    // 1. Initialize VivantioClient with config from .env
    // 2. Verify API connectivity (fetch agent user profile)
    // 3. Cache ticket types, statuses, priorities for reference
    // 4. Start polling loop
  }

  private async pollForTickets() {
    // Query: tickets assigned to agent user, modified since lastPollTime
    // For each new/updated ticket:
    //   - Format ticket as a structured message
    //   - Call onMessage() to deliver to NanoClaw pipeline
    //   - Accept ticket if not yet accepted
  }

  async sendMessage(jid: string, text: string) {
    // jid format: "viv:{ticketId}"
    // Parse ticket ID from JID
    // Post as note/update to the ticket via API
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('viv:');
  }
}

registerChannel('vivantio', (opts) => {
  if (!process.env.VIVANTIO_API_TOKEN) return null;
  return new VivantioChannel(opts);
});
```

**JID Format:** `viv:{ticketId}` (e.g., `viv:12345`)

**Ticket → Message Formatting:**
```
[Ticket #{DisplayId}] {Title}
Client: {ClientName}
Caller: {CallerName} ({CallerEmail})
Priority: {PriorityName}
Status: {StatusName}
Category: {CategoryName}
Opened: {OpenDate}

Description:
{DescriptionHtml → plaintext}

---
Please triage this ticket.
```

### 1.3 Container Agent Tools (MCP Skills)

**File:** `container/skills/vivantio-tools.md`

A CLAUDE.md skill file that defines Bash-callable tools for the agent inside the container. The tools call the Vivantio API through the credential proxy.

#### Tool 1: `vivantio-search-kb`
```bash
# Search knowledge base articles by keyword
# Usage: vivantio-search-kb "printer not printing"
# Returns: matching articles with title, description, text excerpt
```

**Behavior:**
1. Call `POST api/Article/Select` with query items filtering by keyword in Title/Text
2. Return top 5 matching articles formatted as:
   ```
   Article #{id}: {Title}
   Keywords: {Keywords}
   Rating: {AverageRating}
   ---
   {Description or Text excerpt (first 500 chars)}
   ```

#### Tool 2: `vivantio-client-history`
```bash
# Get recent tickets for a client
# Usage: vivantio-client-history {clientId} [limit]
# Returns: last N tickets for the client with status and resolution
```

**Behavior:**
1. Call `POST api/Ticket/SelectPage` with query filtering by ClientId
2. Sort by OpenDate descending, limit to N results
3. Return formatted list:
   ```
   Ticket #{DisplayId}: {Title}
   Status: {StatusName} | Priority: {PriorityName}
   Opened: {OpenDate} | Resolved: {ResolvedDate}
   Category: {CategoryName}
   Solution: {SolutionHtml excerpt}
   ```

#### Tool 3: `vivantio-search-tickets`
```bash
# Search all tickets by keyword, caller, asset, or category
# Usage: vivantio-search-tickets --field CallerName --value "John Smith"
# Usage: vivantio-search-tickets --keyword "VPN disconnecting"
```

**Behavior:**
1. Build query from parameters
2. Call SelectPage with pagination
3. Return matching tickets with key fields

#### Tool 4: `vivantio-update-ticket`
```bash
# Add a note or update ticket status
# Usage: vivantio-update-ticket {ticketId} --note "Investigation findings..."
# Usage: vivantio-update-ticket {ticketId} --internal "Agent notes (not visible to client)"
# Usage: vivantio-update-ticket {ticketId} --status {statusId}
```

**Behavior:**
1. Call `POST api/Ticket/AddNote` with Notes/InternalComment
2. Optionally call ChangeStatus
3. Return confirmation

#### Tool 5: `vivantio-get-ticket`
```bash
# Get full ticket details including action history
# Usage: vivantio-get-ticket {ticketId}
```

#### Tool 6: `vivantio-get-assets`
```bash
# Get assets linked to a client or caller
# Usage: vivantio-get-assets --client {clientId}
# Usage: vivantio-get-assets --caller {callerId}
```

### 1.4 Agent CLAUDE.md (Group Instructions)

**File:** `groups/vivantio_blackhawk/CLAUDE.md`

```markdown
# Blackhawk IT Support Agent

You are a Level 1 IT support technician for Blackhawk Data.
You triage incoming Vivantio ITSM tickets.

## Triage Workflow

When you receive a new ticket:

1. **Read the ticket** — Understand the issue from title, description, and caller info
2. **Search Knowledge Base** — Use `vivantio-search-kb` with relevant keywords
3. **Check Client History** — Use `vivantio-client-history {clientId}` to find:
   - Previous similar issues for this client
   - Recurring device/network problems
   - Related tickets that may indicate a pattern
4. **Search Related Tickets** — Use `vivantio-search-tickets` to find similar
   issues across all clients that may have known solutions
5. **Assess & Update** — Based on findings:
   - If KB article applies: update ticket with solution reference and steps
   - If similar past ticket found: reference it and apply known fix
   - If no match found: update ticket with triage notes acknowledging
     the issue and stating it's under active investigation

## Update Guidelines

- Always add a **public note** to the ticket so the client sees progress
- Use **internal comments** for your analysis and reasoning
- Be professional, concise, and empathetic in client-facing notes
- Reference KB article IDs and past ticket numbers when applicable
- Never close a ticket — escalate or leave for human review

## Example Client-Facing Note

"Thank you for reporting this issue. We've reviewed your request and
identified a similar resolution in our knowledge base (Article #1234).
[Steps from KB article]. If this doesn't resolve the issue, we'll
continue investigating. — Blackhawk IT Support"

## Example Internal Note

"Triage: Checked KB — no direct match. Client has 3 prior tickets
related to VPN issues (#5678, #5690, #5701), all resolved by
resetting VPN profile. Likely same root cause. Recommending same
fix in client note."
```

### 1.5 Environment Variables

Add to `.env`:
```bash
VIVANTIO_API_TOKEN=your-api-token-here
VIVANTIO_BASE_URL=https://webservices-na01.vivantio.com
VIVANTIO_AGENT_USER_ID=12345          # The user ID the agent acts as
VIVANTIO_POLL_INTERVAL=60000          # Poll interval in ms (default 60s)
VIVANTIO_ASSIGNED_GROUP_ID=           # Optional: only poll tickets assigned to this group
```

### 1.6 Credential Proxy Update

Update `src/credential-proxy.ts` to inject `VIVANTIO_API_TOKEN` into outbound requests to the Vivantio API, keeping the token out of containers.

---

## Phase 2: AI-Powered Issue Resolution

Building on Phase 1, the agent gains the ability to research solutions using AI reasoning and external knowledge.

### 2.1 Enhanced Triage with Deep Analysis

Update the agent CLAUDE.md to include a second-pass analysis:

```markdown
## Deep Analysis (Phase 2)

If initial KB/history search yields no solution:

1. **Analyze the technical issue** — Break down the problem description
   into symptoms, affected systems, and potential root causes
2. **Research solutions** — Use your knowledge of IT systems to suggest
   diagnostic steps and potential fixes
3. **Draft resolution steps** — Write step-by-step instructions
   the client or a technician can follow
4. **Update ticket** with:
   - Public note: suggested diagnostic steps for the client
   - Internal note: full analysis, potential root causes, recommended
     escalation path if self-service doesn't resolve
```

### 2.2 Scheduled Re-Check

Use NanoClaw's task scheduler to periodically re-check tickets the agent has triaged:

```markdown
## Follow-Up Protocol

After initial triage, schedule a 4-hour follow-up:
- Check if the ticket has been updated by the client
- If client confirmed resolution: add closing note
- If client reported issue persists: escalate analysis
- If no client response: add gentle follow-up note
```

### 2.3 Pattern Detection

Agent periodically analyzes recent tickets to detect:
- **Outage patterns** — Multiple clients reporting same issue = potential outage
- **Recurring issues** — Same client, same problem = needs permanent fix
- **SLA risks** — Tickets approaching SLA deadlines needing escalation

---

## Implementation Roadmap

### Sprint 1 (Week 1-2): Foundation
| Task | Description |
|------|-------------|
| API Client | Build `src/vivantio/api-client.ts` with typed methods |
| API Discovery | Test query syntax, auth flow, field mappings with live API |
| Channel Skeleton | Implement `VivantioChannel` with polling + message delivery |
| JID Routing | Wire up `viv:` JID format in router |

### Sprint 2 (Week 2-3): Agent Tools
| Task | Description |
|------|-------------|
| Container Tools | Build bash-callable tools for KB search, ticket history, updates |
| Credential Proxy | Add Vivantio token forwarding |
| Group Setup | Create `groups/vivantio_blackhawk/` with CLAUDE.md |
| End-to-End Test | Poll a test ticket → triage → update flow |

### Sprint 3 (Week 3-4): Polish & Phase 2 Start
| Task | Description |
|------|-------------|
| Error Handling | Rate limits, API errors, malformed responses |
| Duplicate Detection | Don't re-triage tickets already processed |
| Scheduled Follow-ups | Implement 4-hour re-check tasks |
| AI Analysis | Enhanced CLAUDE.md with deep analysis prompts |
| Monitoring | Log all API calls, agent decisions, ticket updates |

---

## Key Design Decisions

### Why a Channel (not just a scheduled task)?

A channel provides:
- **Real-time message routing** through NanoClaw's existing pipeline
- **Session continuity** — the agent remembers prior context per ticket/client
- **IPC support** — agent can send messages, schedule tasks
- **Multi-ticket queuing** — NanoClaw's group queue handles concurrency
- **Consistent logging** — all interactions stored in SQLite

### Why polling (not webhooks)?

Vivantio's API docs show no webhook/event subscription endpoints. Polling every 60s is reliable and sufficient for ITSM triage SLAs (typically 15-60 minute response targets).

### Why tools in the container?

The agent needs to make dynamic, context-dependent API calls (search KB with keywords from the ticket, look up specific clients). Container tools let Claude decide what to query based on the ticket content, rather than pre-fetching everything.

### Ticket Deduplication

Track processed tickets in SQLite to avoid re-triaging:
```sql
CREATE TABLE vivantio_processed_tickets (
  ticket_id INTEGER PRIMARY KEY,
  last_action_id INTEGER,    -- last action we've seen
  last_processed TEXT,        -- ISO timestamp
  status TEXT                 -- 'triaged', 'following_up', 'escalated'
);
```

---

## Risk & Mitigation

| Risk | Mitigation |
|------|------------|
| API rate limiting | Exponential backoff, cache config data, batch where possible |
| Agent posts incorrect info | Internal-first note policy; human reviews before client sees |
| Query syntax unknown | Phase 0: API discovery sprint to map exact query operators |
| Token expiry | Monitor 401 responses, alert for re-auth |
| Duplicate processing | SQLite tracking table with last_action_id |

---

## Environment Setup Checklist

- [ ] Obtain Vivantio API token with appropriate permissions
- [ ] Identify the agent's Vivantio User ID
- [ ] Identify the assignment group for agent tickets
- [ ] Map ticket type IDs, status IDs, priority IDs
- [ ] Set up a test ticket queue for development
- [ ] Configure `.env` with Vivantio credentials
- [ ] Register the vivantio_blackhawk group in NanoClaw
