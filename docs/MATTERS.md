# Matters Architecture

## The Matter — Nexus's Core Operational Unit

A **matter** is a bounded piece of work that flows through Nexus. It is the most
important entity in the system — the unit that gets classified, tracked, resolved,
and learned from.

A matter may be as simple as a single Discord question, or as complex as a
multi-day, cross-channel workflow involving customers, operators, skills, and
external systems.

```
                     Matter #427
                  ┌──────────────────────────────────────────┐
                  │                                          │
  Email in ──────>│  Agent Session (one workspace, one JSONL)│
                  │                                          │
  Discord  <─────>│  query() ──> query() ──> query()         │
                  │     ↑           ↑           ↑            │
                  │   email      operator    skill run       │
                  │  received    responds    + reply          │
                  │                                          │
  Email out <─────│                                          │
                  │                                          │
                  └──────────────────────────────────────────┘
                           │
                           ▼  on resolution
                    Memory Capture
                  (classified, PII-filtered)
```

### Matter vs Session vs Agent Session

| Concept | What it is | Lifecycle |
|---|---|---|
| **Matter** | A piece of work spanning one or more channels | Created by trigger, resolved when complete |
| **Session** | The gateway's tracking record for a matter | Stored in Store, has `deletedAt` for soft-delete |
| **Agent Session** | The Claude Code conversation (JSONL) | Resumed via `resume: sessionId`, carries full context |

A matter encompasses one session and one agent session. The session is the
persistence layer, the agent session is the conversation layer, and the matter
is the operational layer that adds:

- **Cross-channel routing** — multiple channels contribute to one matter
- **Lifecycle** — open → active → resolved (not just "exists until deleted")
- **Classification** — memory tier, privacy level, community scope
- **Resolution** — triggers memory capture with appropriate filtering

For simple single-channel conversations, a matter degenerates to a session.
The matter concept exists for when work spans channels.

---

## Information Tiers

All information in Nexus falls into one of four tiers. These determine where
memories are stored, who can recall them, and how they flow through the
container hierarchy.

| Tier | Scope | Container tag pattern | Example content |
|---|---|---|---|
| **Simtricity IP** | All operators | ROM (baked into image) | Platform features, UK energy regulations |
| **Operator** | One B2B customer | `nexus-{operator}` | Team preferences, billing practices, operational decisions |
| **Community** | One community within an operator | `nexus-{operator}:{community}` | Battery schedules, tariffs, member data, community procedures |
| **Customer PII** | Ephemeral / redacted | Not stored (or redacted before storage) | Customer names, debts, addresses, account numbers |

### Hierarchical Recall

Memory recall follows the container hierarchy — child containers include
parent memories, and parent containers include child memories:

```
nexus-foundry (operator)
  ├── nexus-foundry:hmce (community)
  └── nexus-foundry:wlce (community)
```

| Searching from... | Containers searched | Parallel API calls |
|---|---|---|
| HMCE channel | `nexus-foundry:hmce` + `nexus-foundry` | 2 |
| WLCE channel | `nexus-foundry:wlce` + `nexus-foundry` | 2 |
| Operator general channel | `nexus-foundry` + all child containers | 1 + N children |
| Web-chat (default) | `nexus-foundry` | 1 |

Results are merged and deduplicated by memory ID before injection into the
system prompt.

### Hierarchical Capture

Capture always writes to **one** container — the matter's classified tier:

| Matter context | Captured to | Why |
|---|---|---|
| General Discord / web-chat | `nexus-foundry` | Operator-wide knowledge |
| HMCE operations channel | `nexus-foundry:hmce` | Community-specific |
| HMCE billing channel (PII) | `nexus-foundry:hmce` (redacted) | PII stripped, business insight kept |
| Cross-channel matter | Tier of the originating trigger | Email from HMCE customer → `nexus-foundry:hmce` |

---

## Channel Structure from Config

Nexus provisions Discord channel structure from operator configuration.
The operator config is the source of truth — Discord is the output, not the input.

### Operator Config Schema

```json
{
  "name": "Microgrid Foundry",
  "slug": "foundry",
  "communities": [
    {
      "slug": "hmce",
      "name": "Hazelmead Community Energy",
      "containerTag": "nexus-foundry:hmce"
    },
    {
      "slug": "wlce",
      "name": "Water Lilies Community Energy",
      "containerTag": "nexus-foundry:wlce"
    }
  ],
  "discord": {
    "provision": true,
    "categories": [
      {
        "name": "General",
        "channels": [
          { "name": "general", "tier": "operator" },
          { "name": "training", "tier": "operator" }
        ]
      },
      {
        "name": "HMCE",
        "community": "hmce",
        "channels": [
          { "name": "hmce-operations", "tier": "hmce" },
          { "name": "hmce-customer-billing", "tier": "hmce", "private": true, "piiFilter": true }
        ]
      },
      {
        "name": "WLCE",
        "community": "wlce",
        "channels": [
          { "name": "wlce-operations", "tier": "wlce" }
        ]
      }
    ]
  }
}
```

### Channel Provisioning on Startup

When the Discord bot connects, the gateway:

1. Reads operator config `discord.categories`
2. Creates missing categories and channels via Discord.js API
3. Sets permissions on private channels (bot + operator role only)
4. Logs any channels that exist in Discord but aren't in config (informational)

This ensures every operator's Discord server has the right structure without
manual setup. Adding a new community = add to config + redeploy.

### Auto-Classification from Discord Metadata

For channels NOT in the config (operator creates ad-hoc channels), Nexus
infers the tier from Discord metadata:

1. **Category name** → if the category matches a community slug, infer that tier
2. **Channel permissions** → if channel has restricted access, flag as `piiFilter`
3. **Fallback** → `defaultTier` (operator-level)

Config overrides always take precedence over inference.

---

## Matter Lifecycle

### Creation

A matter is created when a triggering event arrives:

| Trigger | Example | Initial tier |
|---|---|---|
| Discord message in a channel | "Battery discharge failed" in #hmce-ops | `hmce` |
| Email from a customer | Sally Smith asks for payment extension | `hmce` (inferred from address/community) |
| Scheduled task fires | Monthly billing review | `operator` |
| Operator initiates via web-chat | "Check the WLCE battery status" | Selected in console, or `operator` default |

The gateway creates the matter with:
- A unique ID (timestamp-based)
- The resolved tier and container tag
- PII filter flag (from channel config)
- A workspace for the agent session

### Cross-Channel Routing

Once a matter exists, messages from any associated channel route to it:

```
Matter #427 (HMCE billing, PII-filtered)
  ├── Email channel: sally@example.com → matter #427
  ├── Discord thread: #hmce-billing/Case-427 → matter #427
  └── Agent responses → routed back to originating channel
```

**Discord threads** are the natural mechanism for matter-specific conversations.
When a matter needs operator attention:

1. Gateway creates a thread in the appropriate channel
2. Thread messages route to the matter's agent session
3. Thread is archived when the matter resolves

### Resolution

A matter resolves when:
- The agent determines the work is complete
- The operator explicitly closes it
- A timeout fires (configurable per tier)

On resolution:
1. **Memory capture** — the full matter transcript is sent for classification
2. **PII classification** — Haiku evaluates the transcript for PII
3. **Redaction** — PII is stripped, business insights preserved
4. **Storage** — redacted summary captured to the matter's container tag
5. **JSONL retention** — raw transcript kept in Store for 30 days (soft-delete)

---

## PII Classification (Haiku)

For matters flagged with `piiFilter`, a Claude Haiku classifier runs on the
transcript before memory capture.

### Classification Flow

```
Matter resolves
    ↓
Haiku classifier receives transcript
    ↓
Output: {
  action: "pass" | "redact" | "skip",
  content: "redacted version if applicable",
  redacted: ["customer name", "debt amount"],
  reason: "Contains customer financial details"
}
    ↓
If pass:  → capture to Supermemory as-is
If redact: → capture redacted version
If skip:  → don't capture (purely sensitive, no business insight)
```

### Classifier Prompt

```
You are a PII classifier for a UK energy community operator.

Given a conversation transcript, determine:
1. Does it contain customer PII? (names, addresses, account numbers,
   debt amounts, payment details, phone numbers, email addresses)
2. If so, can the business insight be preserved without the PII?

Output JSON:
- action: "pass" (no PII), "redact" (PII found, can preserve insight),
  or "skip" (purely personal, no business value)
- content: the redacted version (only if action is "redact")
- redacted: list of what was removed
- reason: brief explanation
```

### Cost and Performance

- ~200ms per classification (Haiku is fast)
- ~$0.001 per classification
- Runs on resolution (once per matter), not per message
- Failure mode: don't capture (conservative default)

---

## Supermemory Container Architecture

### Container Hierarchy Per Operator

```
nexus-foundry                    (operator — shared knowledge)
  ├── nexus-foundry:hmce         (community — Hazelmead)
  ├── nexus-foundry:wlce         (community — Water Lilies)
  └── (future communities added dynamically)
```

### API Key Strategy

Use the **org-level Supermemory API key** (full access) for Fly deployments,
not scoped keys. Scoped keys are limited in how many containers they can access,
and as communities grow, the key would need constant updates.

Container isolation is enforced by Nexus code (the gateway resolves the tier,
the agent routes to the correct container). The Supermemory API key grants
access; our code decides what to access.

Scoped keys remain useful for:
- Claude Code plugin (personal `damonrand` container)
- Future: per-community API access for external dashboards

### Profile Per Container

Each container builds its own Supermemory profile automatically:
- `nexus-foundry` profile: operator-wide facts and preferences
- `nexus-foundry:hmce` profile: HMCE-specific facts
- Profiles are returned by the `/v4/profile` endpoint per container
- Hierarchical recall merges profiles from multiple containers

### Entity Context Per Container

Supermemory supports per-container entity context (set via API or dashboard).
This guides the extraction engine on what to remember:

| Container | Entity context |
|---|---|
| `nexus-foundry` | "Extract operational decisions, team preferences, procedures. Do NOT extract customer names or financial details." |
| `nexus-foundry:hmce` | "Extract community billing patterns, tariff decisions, battery operations. Anonymise customer references." |

This is a third safety net — even if PII slips past the Haiku classifier,
Supermemory's extraction may not promote it to a memory.

---

## Implementation Phases

### Phase 1: Automated Tests (current branch, pre-PR)

Establish regression tests for the existing system before the matter-centric
refactor:
- Store backend tests (session CRUD, soft-delete, purge)
- Memory client tests (API response parsing, container routing)
- Memory hook tests (recall formatting, capture formatting)
- Gateway routing tests (channel classification)

### Phase 2: Container Hierarchy + Channel Routing (`feature/matters`)

- Operator config schema with communities and channel mappings
- Gateway resolves channel → tier at enqueue time
- WorkItem carries `memoryTier` and `memoryContainerTag`
- Memory client accepts per-call container tag
- Hierarchical recall (parallel searches, merge results)
- Discord channel provisioning from config

### Phase 3: Matter System (`feature/matters`)

- Matter entity in Store (wraps session + lifecycle + classification)
- Cross-channel matter routing
- Discord thread creation for matters
- Matter resolution triggers
- Matter-level memory capture (not per-message)

### Phase 4: PII Classification (`feature/matters`)

- Haiku classifier integration
- Per-matter PII evaluation on resolution
- Redaction before memory capture
- Entity context configuration per container

---

## Relationship to OTel

The matter architecture mirrors OpenTelemetry's distributed tracing model:

| OTel | Nexus | Description |
|---|---|---|
| Trace | Matter | Full lifecycle of a piece of work |
| Span | Channel interaction | Individual operation within the matter |
| Trace ID | Matter ID | Propagated across all channels |
| Span attributes | Tier, community, privacy | Classification metadata |
| Context propagation | Matter ID in WorkItem | Links channel events to the right agent session |

Future: instrument Nexus with actual OTel traces for observability, where each
matter is a trace and each channel interaction is a span. This gives us
distributed tracing for free and enables dashboards showing matter flow
across channels.

---

## Open Questions

1. **Email channel** — How does Nexus receive emails? Resend webhook? IMAP polling?
   How does it map an email sender to a community/customer?
2. **Matter timeout** — How long before an unresolved matter auto-closes? Per-tier
   config? What happens to the workspace?
3. **Concurrent matters** — Can an operator have multiple open matters in the same
   community? How does the gateway decide which matter a new message belongs to?
4. **Matter transfer** — Can a matter move between communities? (Customer moves
   from HMCE to WLCE)
5. **Shared learnings** — When a matter in HMCE produces a learning that applies
   to all communities, how does it get promoted to the operator tier?
6. **Console UI** — What does the matters dashboard look like? Timeline? Kanban?
   Filtered by community?
