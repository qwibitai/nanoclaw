# Case Isolation Spec: Customer-Facing Agent Architecture

Status: **Draft** | Author: Aviad + Claude | Date: 2026-03-18

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Agent Roles & Boundaries](#2-agent-roles--boundaries)
3. [Isolation Model](#3-isolation-model)
4. [Customer Interaction Model](#4-customer-interaction-model)
5. [State Management](#5-state-management)
6. [Open Questions & Known Risks](#6-open-questions--known-risks)

---

## 1. Problem Statement

### 1.1 Business Need

NanoClaw is evolving from a personal assistant into a customer-facing agent platform. Customers interact directly with agents via Telegram and email channels to request services, track work, and receive deliverables. Each customer interaction creates a discrete work item (case) that an agent works on.

### 1.2 Why Cross-Work Blindness Is Non-Negotiable

When an agent handles multiple customers' work, it must never — by accident or by design — access data from one customer's case while working on another's. This is a hard confidentiality requirement, not a nice-to-have.

**The MRI example:** Customer A asks about getting an MRI referral. Customer B requests a refund status on their MRI. Customer C wants to purchase an insurance policy covering MRI. All three mention "MRI." Without case isolation, an agent working on Customer C's policy could:

- Hallucinate details from Customer A's referral into C's policy
- Leak Customer B's refund status into a response to Customer A
- Use contextual overlap ("they all asked about MRI") to cross-reference cases

These are not hypothetical risks. LLMs actively seek patterns across available context. If the data is in the context window, the model will use it. The only defense is ensuring the data is never present.

### 1.3 Why Current NanoClaw Isolation Is Insufficient

Current NanoClaw isolates at the **group** level: each Telegram group or chat gets its own container, session, and filesystem. This works for a personal assistant where groups represent different contexts (family, work, side project).

It fails for customer-facing work because:

- **Multiple customers in one group**: A business Telegram group may have multiple customers. Group-level isolation doesn't separate their data.
- **No case-level isolation**: Two cases for the same customer share a container, session, and filesystem. An agent working on Case A can see Case B's scratch files and conversation history.
- **No role-based access control**: The current model doesn't distinguish between an agent that should only answer questions (router) and one that should process customer data (work agent). All agents get the same mounts and tools.
- **Router sees everything**: The current Haiku classifier processes all messages with access to all case context, violating minimum-necessary-access.

### 1.4 Threat Models

| Threat | Description | Severity |
|--------|-------------|----------|
| **Cross-customer data leakage** | Agent working on Customer A's case accesses Customer B's files, conversation history, or CRM data | Critical |
| **Cross-case context contamination** | LLM hallucinates details from one case into another because both are in the context window | Critical |
| **Privilege escalation** | Work agent accesses dev tools (code modification, git push) or dev agent accesses customer data | High |
| **Router data exposure** | Router agent accumulates sensitive case details across all customers | High |
| **Identity confusion** | Agent treats two channel identities (Telegram + email) as different customers when they're the same person, or vice versa | Medium |
| **Stale context after recycle** | Agent container is recycled but retains filesystem or session artifacts from a previous case | High |
| **Lateral movement via shared mounts** | Agent discovers and reads files from other worktrees or case directories through shared mount points | High |

---

## 2. Agent Roles & Boundaries

### 2.1 Router Agent

The customer's first point of contact. Conducts intake interviews, answers service questions, and provides case status updates. The router never does real work — if something requires data access, internet, or file operations beyond its limited scope, it creates a work case.

**Responsibilities:**
- Greet customers, explain available services and workflows
- Conduct intake interviews to gather enough information to open a work ticket
- Answer "what's the status of my case?" from summary data it already has
- Redirect customers to their assigned work agent if they have an open case
- Open new work cases (via MCP tool) when intake is complete

**Access:**
- CRM MCP: case summaries only (name, date, status, one-liner) for the requesting customer
- Case creation MCP tool
- Messaging MCP tool (respond to customer)
- Limited file access (intake-related)
- No internet access
- No customer case data, files, or artifacts
- No dev tools

**What the router explicitly cannot do:**
- Access case details beyond the summary (conclusion, artifacts, conversation transcript)
- Access any customer's files or documents
- Browse the internet or call external APIs
- Modify code or infrastructure
- Access data for a customer other than the one currently messaging

### 2.2 Work Agent

Handles a single case for a single customer. Has access to that customer's data through the CRM, a scratch directory for working files, and tools appropriate for the work type. Assigned a named bot identity for customer communication.

**Responsibilities:**
- Execute the work described in the case (research, analysis, document generation, API calls)
- Communicate progress to the customer via assigned bot identity
- Store artifacts and conclusions in the CRM
- Mark the case done with reflections when complete

**Access:**
- CRM MCP: full data for current case + summaries of same customer's past cases
- Scratch directory: read-write workspace for this case only
- Internet access (for research, API calls as needed by the work)
- Messaging MCP tool (communicate via assigned bot identity)
- Case lifecycle MCP tools (mark done, mark blocked, add comment)
- No access to other customers' data, cases, or files
- No dev tools (git, code modification, PR creation)
- No access to other cases' scratch directories or sessions

### 2.3 Dev Agent

Modifies the platform itself — harness code, vertical-specific code, or company configuration within a vertical. Operates in a git worktree for code isolation. Must be approved or initiated by platform administrators.

**Responsibilities:**
- Implement features, fix bugs, refactor code, update configuration
- Work within an isolated git worktree (own branch, no conflicts with other dev agents)
- Create PRs for review
- Reflect on process improvements (kaizen)

**Access:**
- Git worktree: read-write access to isolated branch of the codebase
- GitHub token: push branches, create PRs
- Dev-specific MCP tools (code, git, case lifecycle)
- No CRM access (hard wall — no customer data)
- No customer-facing communication channels
- No access to work case data, scratch directories, or sessions

**Authorization:**
- Dev cases must be approved or initiated by platform administrators (Garsson admins)
- Non-admin sources can suggest dev cases, but they enter SUGGESTED status and require approval

**Future considerations:**
- Granular access levels: harness changes (highest risk) vs. vertical changes (medium) vs. company config (lowest)
- Companies within a vertical are competitors — dev agent working on Company A's config must never see Company B's
- Audited access to work case data for learning from failures (requires valid business reason, logged)

### 2.4 Role Comparison

| Capability | Router | Work Agent | Dev Agent |
|-----------|--------|------------|-----------|
| CRM: case summaries (own customer) | Yes | Yes | No |
| CRM: full case data | No | Current case only | No |
| Customer files/artifacts | No | Current case only | No |
| Internet access | No | Yes | As needed |
| Scratch directory | No | Per-case | No |
| Git worktree | No | No | Yes (isolated branch) |
| GitHub token | No | No | Yes |
| Customer communication | Yes (as router) | Yes (as assigned bot) | No |
| Case creation | Yes | Suggest only | Suggest only |
| Code modification | No | No | Yes |
| Container type | Warm, persistent | Per-case, recycled on idle | Per-case |

---

## 3. Isolation Model

### 3.1 Four Isolation Layers

Case isolation is enforced by four independent layers. Each layer addresses a different attack surface. If any single layer is compromised, the others still contain the damage.

#### Layer 1: Container Isolation (OS-level)

Every agent runs in a Docker container. The container can only see explicitly mounted paths. An agent cannot access other cases' directories, other worktrees, or host filesystem paths that aren't mounted.

| What it enforces | What it doesn't enforce |
|-----------------|------------------------|
| Filesystem visibility (agent sees only mounted paths) | Data returned by MCP tools (CRM scoping is Layer 3) |
| Process isolation (agent can't affect host or other containers) | Network-level data access (agent could hit APIs) |
| No lateral movement to other worktrees or case directories | Tool availability (MCP restriction is Layer 4) |

**Mounts by role:**

| Mount | Router | Work Agent | Dev Agent |
|-------|--------|------------|-----------|
| `/workspace/case` (scratch dir) | No | `data/case-workspaces/{case-id}/` | No |
| `/workspace/case` (worktree) | No | No | `.claude/worktrees/{case-name}/` |
| `/home/node/.claude` (session) | Per-customer session dir | Per-case session dir | Per-case session dir |
| `/workspace/project` (read-only) | No | No | Possibly (or worktree is sufficient) |
| CRM MCP socket/access | Yes (summaries only) | Yes (scoped to customer) | No |

#### Layer 2: Git Worktree Isolation (dev agents only)

Dev agents work in isolated git worktrees. Each worktree is a separate branch of the codebase. Commits, changes, and working state in one worktree cannot affect another. This prevents concurrent dev agents from creating merge conflicts or corrupting each other's work.

| What it enforces | What it doesn't enforce |
|-----------------|------------------------|
| Branch isolation (no commit conflicts between dev agents) | Filesystem visibility (that's Layer 1) |
| Independent working state per dev case | Access to customer data (that's Layer 3) |

#### Layer 3: CRM Data Scoping (data-level)

The CRM MCP server enforces per-customer data access. Each agent's container receives a `NANOCLAW_CUSTOMER_ID` (or `NANOCLAW_CASE_ID` which maps to a customer). The CRM MCP server validates every query against this identity.

| What it enforces | What it doesn't enforce |
|-----------------|------------------------|
| Agent can only query its assigned customer's data | Filesystem access (that's Layer 1) |
| Router sees summaries only; work agents see full case data | Tool availability (that's Layer 4) |
| Hard reject (not empty result) on unauthorized queries | |

**Access control matrix:**

| CRM Operation | Router | Work Agent | Dev Agent |
|--------------|--------|------------|-----------|
| List cases (summaries) for own customer | Yes | Yes | No |
| Read full case data for current case | No | Yes | No |
| Read full case data for past cases (same customer) | No | Yes (explicit request) | No |
| Read any other customer's data | No | No | No |
| Write case data (notes, artifacts, status) | Create only | Current case only | No |

#### Layer 4: MCP Tool Restriction (capability-level)

Each agent role receives a different set of MCP tools. A work agent literally does not have the `git_push` or `create_pr` tool available. A dev agent does not have the CRM query tool. The restriction is enforced by the MCP server configuration loaded into the container.

| What it enforces | What it doesn't enforce |
|-----------------|------------------------|
| Agent can only invoke tools appropriate to its role | Data returned by allowed tools (that's Layer 3) |
| Dev agent can't query CRM; work agent can't push code | Filesystem access (that's Layer 1) |

### 3.2 Container Lifecycle & Recycling Safety

When a container is recycled (stopped due to idle timeout, then restarted for a new message), there must be zero residual state from a previous case.

**Why this is safe with per-case containers:** Each case gets its own container. The container mounts only that case's session and scratch directories. When the container is recycled and restarted for the same case, it remounts the same directories — this is correct and intended. A container is never reassigned to a different case. When a case completes, the container is destroyed, and the session/scratch directories are archived or pruned.

**If container pooling is ever implemented (not planned):** Containers would need full filesystem remount and session wipe between assignments. Docker does not support hot-swapping mounts on running containers, so this would require stopping and restarting the container with new mounts — at which point it's equivalent to a fresh container. Application-level context switching within a shared container is explicitly rejected per NanoClaw's design philosophy.

### 3.3 Customer Identity Model

Customers are identified by a `customer_id` that may be linked to multiple channel identities.

```
identities table:
  identity_id | channel  | channel_user_id | customer_id | verified_at
  ------------+----------+-----------------+-------------+------------
  id-1        | telegram | tg:12345        | cust-001    | 2026-03-01
  id-2        | email    | tom@gmail.com   | cust-001    | 2026-03-05
  id-3        | telegram | tg:67890        | cust-002    | 2026-03-10
```

- Each new channel interaction creates an identity with a new `customer_id`
- Identities start as separate customers (one identity = one customer)
- **Identity merging via 2FA**: If TelegramTom claims to also be EmailTom, a verification code is sent to the email address. If TelegramTom provides the correct code, the two identities are merged under one `customer_id`. All cases and history are unified.
- Router and CRM always query by `customer_id`, so merged identities see unified case history

### 3.4 Dev-Work Firewall

**Current design (hard wall):**
- Dev agents have zero access to CRM, customer data, work case files, or work case sessions
- Work agents have zero access to code, git, or dev case worktrees
- No exceptions

**Future direction (audited access):**
- Dev agents may need access to anonymized work case data for learning from failures
- Access would require: valid business reason, admin approval, full audit logging
- Customer PII must be stripped before dev agent access
- Companies within a vertical are competitors — dev agent working on Company A must never see Company B's data

---

## 4. Customer Interaction Model

### 4.1 Agent Swarm & Named Identities

Agents have persistent named identities that are reused across cases and customers. The bot name is decoupled from the case — a bot named "Alice" might handle Customer X's case today and Customer Y's tomorrow.

**Naming conventions:**
- **Work agents**: Names inspired by the project's Garcon (waiter) origin — service-oriented names
- **Dev agents**: Distinct naming convention (e.g., Jeeves, MaitreD, or D-prefixed names) to clearly separate from customer-facing agents
- **Router**: Has its own fixed identity (the "front desk")

**Why persistent names:**
- Customers build familiarity ("Alice helped me last time")
- Names don't reveal case details (no case IDs or descriptions in bot names)
- Bots are reusable — freed when a case completes, assigned to the next case
- A customer can talk to 2+ agents on different cases simultaneously

**Swarm sizing** (number of concurrent agent instances) is a resource management question — out of scope for this spec. The architecture must support any reasonable number.

### 4.2 Intake Flow

```
Customer messages Router bot
  → Router loads customer's conversation history (from per-customer session)
  → Router queries CRM: "list cases for this customer" → gets summaries

  Case A: Customer has no open cases
    → Router conducts intake interview
    → Gathers enough info to open a work ticket
    → Router creates case via MCP (case type=work, intake data stored in CRM)
    → Work agent bot (e.g., "Alice") is assigned to the case
    → Alice initiates conversation with customer via Telegram/email
    → Router conversation for this customer resets or continues for future intake

  Case B: Customer has open case(s)
    → Router tells customer: "You have an open case with Alice — you can message her directly"
    → If customer wants a NEW case (different topic): Router conducts intake → new case → different bot assigned
    → If customer wants status: Router answers from summary data

  Case C: Customer asks about services
    → Router answers from its static knowledge of available services/workflows
    → No case created
```

### 4.3 Multi-Case Concurrent Work

A customer can have multiple open cases handled by different bots simultaneously.

```
Customer Tom:
  Case 1 (MRI referral)     → assigned to "Alice"
  Case 2 (refund status)    → assigned to "Bob"

Tom messages Alice → message goes to Case 1's container
Tom messages Bob   → message goes to Case 2's container
Tom messages Router → intake for new case or status check
```

No LLM classification is needed. The Telegram bot identity IS the routing mechanism. Which bot you message determines where your message goes.

### 4.4 Email Identity

Email follows the same model using plus-addressing or subdomains:

```
prints+alice@garsson.io  → routes to Alice's assigned case for this customer
prints+bob@garsson.io    → routes to Bob's assigned case for this customer
prints@garsson.io        → routes to router (intake)
```

This works with standard Gmail/Google Workspace without separate mailboxes.

### 4.5 Mechanistic Responses (No LLM)

When a customer messages a bot that can't currently serve them, a mechanistic (no LLM) response is sent. This is fast, free, and never hallucinates.

| Scenario | Mechanistic Response |
|----------|---------------------|
| Customer messages Alice, but Alice is busy with another customer's case | "I'm currently working on another case. I'll get back to you when I'm available." |
| Customer messages Alice, but Alice has no open case for this customer | "I don't have an open case for you. Contact [Router] to open a new one." + if another bot has their open case: "Or you can reach out to Bob, who is handling your current case." |
| Customer messages a dev agent bot | "This agent handles internal development. Contact [Router] for customer service." |
| Bot assigned to case but case is DONE/REVIEWED | "This case has been completed. Contact [Router] if you need further help." |

### 4.6 Pitfalls Being Prevented

| Pitfall | How it's prevented |
|---------|-------------------|
| Agent leaks Customer A's data to Customer B | Container isolation (separate containers per case) + CRM scoping (queries rejected for wrong customer) |
| Agent hallucinates details from a related case | Cases are never in the same context window — separate containers, sessions, and CRM scoping |
| Customer messages wrong bot, gets confused | Mechanistic responses redirect to the right bot or router — no LLM guessing |
| Router accumulates sensitive data over time | Router only has access to case summaries, never full case data. Router sessions are per-customer, not global |
| Work agent accesses dev tools | MCP tool restriction — `git_push`, `create_pr` etc. are not available to work agents |
| Dev agent reads customer data | CRM MCP tool is not available to dev agents. Customer case directories are not mounted |
| Stale data after container recycle | Containers are per-case, never reassigned. Session and scratch dirs are per-case on the host |
| Two agents modify same code | Git worktree isolation — each dev agent has its own branch |
| Identity confusion across channels | Customer identity model with 2FA-based merging. CRM queries by `customer_id`, not channel identity |

---

## 5. State Management

### 5.1 State by Role

#### Router

The router is a warm, persistent container serving multiple customers. It processes messages sequentially (one at a time). Each message is a separate `claude` invocation within the container, using `--resume` with a per-customer session ID.

| State | Storage | Lifecycle |
|-------|---------|-----------|
| Conversation with Customer X | Claude session files at `.claude/sessions/router/{customer-id}/` | Persists across interactions. Pruned when customer is inactive for extended period. |
| Customer's case list | CRM query (live, per-message) | Not cached — always fresh from CRM |
| Available services/workflows | System prompt or CLAUDE.md | Static, updated on deploy |

**Flow:**
```
Customer X messages router bot
  → Router container is already warm
  → Invoke: claude --resume {customer-X-session-id}
  → Claude sees full conversation history with X (from session files)
  → Claude queries CRM MCP: "list cases for customer X" → summaries only
  → Claude processes message, responds
  → Session files updated on disk
  → Ready for next message (could be any customer)
```

**Concurrency:** Messages are serialized within one router instance. If Customer A's message is being processed, Customer B waits. This is acceptable because router interactions are short (intake questions, status lookups). If latency becomes an issue, scale to multiple router instances.

#### Work Agent

Each active case gets its own container. The container mounts only that case's data. State persists on the host filesystem and in the CRM, surviving container recycling.

| State | Storage | Survives recycle? |
|-------|---------|-------------------|
| Conversation context | Claude session files at `.claude/sessions/case/{case-id}/` | Yes |
| Working files (downloads, drafts) | Scratch dir at `data/case-workspaces/{case-id}/` | Yes |
| Case data (transcript, artifacts, conclusions) | CRM (via MCP) | Yes |
| Customer's past cases | CRM query (scoped to this customer) | Yes |
| In-memory state (mid-operation) | Container RAM | No |

#### Dev Agent

Same as work agent, but with a git worktree instead of a scratch directory.

| State | Storage | Survives recycle? |
|-------|---------|-------------------|
| Conversation context | Claude session files at `.claude/sessions/case/{case-id}/` | Yes |
| Code changes | Git worktree at `.claude/worktrees/{case-name}/` | Yes (committed to branch) |
| Case metadata | SQLite + kaizen backend | Yes |
| In-memory state | Container RAM | No |

### 5.2 Container Lifecycle

```
1. CASE CREATED (from router intake)
   → SQLite: insert case record (case-id, customer-id, status=ACTIVE)
   → CRM: create case with intake data (interview transcript)
   → Host: mkdir data/case-workspaces/{case-id}/
   → Host: mkdir .claude/sessions/case/{case-id}/
   → Assign bot identity → store in case-bot assignment table

2. FIRST MESSAGE (case start)
   → Spawn container with per-case mounts and env vars
   → Agent reads intake data from CRM, begins work

3. FOLLOW-UP MESSAGE (container still alive)
   → Message piped to running claude process
   → Agent continues in same session

4. IDLE TIMEOUT (container recycled)
   → Container stops after N minutes idle
   → Session files + scratch dir remain on host
   → CRM state already persisted

5. RESUME (new message after recycle)
   → Spawn NEW container with SAME per-case mounts
   → claude --resume {session-id}
   → Agent sees full conversation history + working files + CRM state
   → Continues where it left off

6. CASE DONE
   → Agent marks done via MCP → artifacts synced to CRM
   → Container destroyed
   → Session files archived or pruned
   → Scratch dir pruned (artifacts already in CRM)
   → Bot identity freed for reassignment
```

### 5.3 What Claude's --resume Provides

Claude's `--resume` flag restores the full conversation context from session files. This includes every message sent and received, every tool call and result, every decision the agent made. On resume, the agent sees its complete history and can pick up where it left off without custom state management.

The scratch directory provides file persistence (downloads, generated documents survive recycling). The CRM provides data persistence (case records, artifacts, conclusions). Together with `--resume`, these three mechanisms cover all state that needs to survive container recycling.

**Known limitation:** If a container is killed ungracefully (not idle timeout but force-kill), the Claude process may be interrupted mid-tool-call. On resume, the agent sees the conversation up to the last completed message. The in-progress operation is lost and the agent must detect the interruption and retry.

### 5.4 Token and Subscription Model

If upstream NanoClaw operates on subscription tokens (Claude Max/Pro) instead of API tokens, this architecture must also work with subscription tokens. The isolation model (containers, CRM scoping, MCP restriction) is independent of the authentication method — it doesn't matter whether the Claude invocation uses an API key or a subscription token.

If a subscription token lacks privileges that the architecture requires (e.g., certain API features), that limitation would also apply to standard upstream NanoClaw usage and is not a regression introduced by this design.

---

## 6. Open Questions & Known Risks

### 6.1 Requires Detailed Design

| Question | Context | Options to Explore |
|----------|---------|-------------------|
| **CRM MCP server** | No CRM MCP server exists yet. Needs design for data model, access control enforcement, and per-customer scoping. | Custom build vs. adapter over existing CRM (HubSpot, Zammad). GitHub Issues (current backend) lacks the access control granularity. |
| **Container keep-alive model** | How long does a work agent container stay alive between messages? | Heartbeat (agent sends periodic signals, no signal for N min → kill), message-driven (no messages for N min → kill), or explicit (agent calls `case_pause` when waiting for input). Heartbeat model already exists for dev worktree locks. |
| **Router file access scope** | Router needs "limited file access" — what exactly? | Read intake attachments (customer sends a document via Telegram)? Write interview notes? Access to specific intake-related directories only? |
| **CRM data model** | What fields, relations, and query patterns does the CRM need to support? | Needs design document — depends on vertical-specific workflows. |
| **Bot-case assignment table** | How are bot identities managed, assigned, and freed? | Simple table: `bot_id, case_id, customer_id, assigned_at, freed_at`. Need policies for: what happens when all bots are busy? Queue? Reject? |
| **Agent SDK session switching** | Can the Claude Agent SDK efficiently switch between `--resume` sessions in one container? | Needed for the warm router model. Each invocation is a separate `claude` process, so it should work — but needs verification. |

### 6.2 Known Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| **CRM MCP becomes single point of failure** | High | CRM must be highly available. Fallback: agent can still work with local scratch files if CRM is temporarily unreachable. Design for graceful degradation. |
| **Router serialization bottleneck** | Medium | Router processes one message at a time. If many customers message simultaneously, queue grows. Mitigation: router interactions are designed to be short. Scaling path: multiple router instances. |
| **Session file growth** | Medium | Long-running cases accumulate large session files. Claude's context window has limits. Mitigation: periodic session compaction (Claude's `/compact`), archival of old sessions. |
| **Bot identity exhaustion** | Low | If all bots are assigned to active cases, new cases can't get a bot. Mitigation: monitor utilization, scale bot pool as needed, queue new cases. |
| **Ungraceful container termination** | Low | Mid-operation state lost on force-kill. Mitigation: design operations to be idempotent where possible. Agent detects interruption on resume and retries. |
| **Identity merge conflicts** | Low | When merging two customer identities, their case histories combine. If both had active cases with the same bot, conflicts arise. Mitigation: merge process checks for conflicts and reassigns if needed. |

### 6.3 Future Directions (Out of Scope)

- **Dev case access granularity**: Harness changes (highest risk) vs. vertical changes vs. company config. Different approval levels per scope.
- **Audited dev-to-work access**: Dev agents accessing anonymized work case data for learning from failures, with business justification and audit trail.
- **Multi-vertical isolation**: Companies within a vertical are competitors. Dev agents must be scoped to one company's config.
- **Router scaling**: Multiple router instances with shared customer session state.
- **Customer self-service portal**: Web UI for customers to view case status, upload documents, without going through chat channels.
