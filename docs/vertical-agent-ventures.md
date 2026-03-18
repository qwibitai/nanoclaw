# Vertical Agent Ventures: Market, Architecture, and Strategy

Status: **Draft** | Date: 2026-03-18

Related: [Case Isolation Spec](case-isolation-spec.md) | [kaizen#65](https://github.com/Garsson-io/kaizen/issues/65)

---

## Context

Garsson Harness is a closed-source, customer-facing agent platform built on NanoClaw's open-source infrastructure. Each work item (case) runs in an isolated container with per-customer data scoping. The harness powers a portfolio of vertical ventures — each venture is a separate private repo with domain-specific workflows, operated by a domain operator who knows the industry.

This memo argues two things: first, that customer-facing AI agents deployed into real business workflows need stronger operational boundaries than current platforms provide. Second, that the business opportunity is in messy, under-served, service-heavy verticals — not in generic support chat or enterprise SaaS.

---

## Thesis

AI can automate exception-heavy service workflows in under-served verticals, but only if deployed through a constrained operating model: case-level isolation, scoped data access, domain operators, and recursive improvement.

This is not a thesis about winning generic customer support. It is about a specific class of workflows: multi-step, multi-party, data-sensitive operations in industries where the current tooling is WhatsApp groups, spreadsheets, and phone calls.

**The thesis is wrong if:**

- Application-level isolation (prompt engineering, DB row filtering, policy engines) turns out to be sufficient for customer-facing deployments in sensitive workflows — making OS-level isolation an unnecessary cost
- Large platforms (Sierra, Agentforce) move downmarket fast enough to serve small local businesses before we establish vertical footholds
- Domain operators turn out to be unnecessary — i.e., small businesses adopt AI agent tooling directly from generic SaaS providers without needing a trusted industry partner
- The operational overhead of per-case containers makes the unit economics unworkable at scale

---

## What Case Isolation Means

Case isolation means each work item runs in its own container with access only to the data it needs. No case can see another case's data, even if both cases belong to the same customer.

These boundaries are enforced at different layers:

- **Runtime isolation**: Each case gets its own container — separate filesystem, process space, network
- **Data isolation**: CRM MCP server scopes queries to the current case's customer. Queries for other customers are rejected.
- **Capability isolation**: MCP tools are restricted by agent role. Work agents get read-only CRM. Dev agents get code tools but no customer data.
- **Identity isolation**: Bot identity determines routing. Which bot you message determines which case handles your request.

Containerization is the easy part. Safe, scoped data access and identity resolution are the hard parts.

---

## Why This Market May Be Open Now

Most small businesses will not build this automation themselves. They lack both the technical capacity and the economic reason to become software integrators.

Large platforms (Salesforce, ServiceNow, Sierra) serve enterprises with dedicated IT teams and six-figure contracts. They are unlikely to prioritize a printing workshop in Holon or an insurance broker in Netanya in the near term.

Open-source agent frameworks (OpenClaw, NanoClaw) give developers tools to build personal assistants, but they are not designed for customer-facing multi-tenant deployment where data leakage between customers is a trust-destroying event.

The gap is: **nobody is building agent infrastructure specifically for domain operators who serve small businesses in local markets.** The value pool is not mainly SaaS budget — it is operator time currently spent on manual coordination, quoting, follow-up, and exception handling.

A vertical tuned for the Israeli printing industry is unlikely to face a deeply localized global competitor in the near term — the market is too small for large platforms to prioritize, but large enough to sustain a focused venture.

---

## 1. The Claw Ecosystem

### 1.1 OpenClaw

One of the largest open-source AI agent projects. Multi-channel (Slack, Discord, Telegram, WhatsApp, webchat). Single-operator model — the official docs explicitly state it is "not designed as a hostile multi-tenant security boundary for multiple adversarial users sharing one agent/gateway."

**Business model:** Acquired by NVIDIA (Nemoclaw). Open-source builds adoption; NVIDIA monetizes via GPU/cloud compute.

| Aspect | OpenClaw | Garsson Harness |
|--------|----------|-----------------|
| Isolation model | Application-level (permission checks, allowlists) | OS-level (containers per case) |
| Multi-tenant | Not designed for it | Customer-facing with per-case isolation |
| Case/work-item abstraction | None | Full lifecycle (SUGGESTED → PRUNED) |
| Customer data scoping | None | CRM MCP with per-customer access control |
| Agent roles | Single role (one agent does everything) | Three roles (router, work, dev) with distinct trust boundaries |
| Codebase size | ~500K lines, 70+ dependencies | ~4K lines, minimal dependencies |

**Relevant development:** OpenClaw issue #17299 proposes an "Agents Plane" for native multi-tenant agent provisioning and isolation. Not yet implemented — indicates the community recognizes the gap.

### 1.2 Lobu

Multi-tenant wrapper for OpenClaw. Appears to be the closest competitor in the Claw ecosystem.

| Aspect | Lobu | Garsson Harness |
|--------|------|-----------------|
| Isolation level | Per-channel/DM | Per-case (work item) |
| Programmatic agent creation | REST API | MCP tools + IPC |
| Customer identity | Implicit (channel user) | Explicit customer model with 2FA identity merging |
| CRM integration | None | CRM MCP server with per-customer scoping |
| Case lifecycle | None | Full lifecycle with kaizen feedback |
| Agent roles | Single role per channel | Router / work / dev with different access |

**Key gap:** Lobu isolates per channel, not per work item. If a customer has two concurrent issues, they share the same channel isolation boundary. Our model gives each case its own container and data scope.

### 1.3 ClawSwarm

Multi-agent system by The Swarm Corporation. Compiles to Rust, built on the Swarms framework. Unified messaging across Telegram, Discord, WhatsApp.

| Aspect | ClawSwarm | Garsson Harness |
|--------|-----------|-----------------|
| Multi-agent model | Hierarchical (director → specialists) | Swarm with named identities (router → case workers) |
| Focus | Agent collaboration on shared tasks | Customer isolation across separate tasks |
| Data isolation | Not a design goal | Core design goal |
| Customer-facing | No | Yes |

**Relevance:** ClawSwarm's hierarchical delegation pattern is interesting but solves a different problem (agent collaboration vs customer isolation).

### 1.4 Praktor

Claude Code orchestrator with Telegram I/O, Docker isolation, swarm patterns, Mission Control UI. Secrets encrypted at rest (AES-256-GCM).

| Aspect | Praktor | Garsson Harness |
|--------|---------|-----------------|
| Target use | Dev orchestration | Customer-facing + dev |
| Container isolation | Yes | Yes |
| Customer data scoping | None | CRM MCP with per-customer access control |
| Case management | None | Full lifecycle |
| Secrets management | AES-256-GCM encrypted | Credential proxy (no secrets in containers) |

**Worth studying:** Mission Control UI and secrets management approach.

### 1.5 NanoClaw (our upstream)

Lightweight, security-focused alternative to OpenClaw. One Node.js process, container-isolated agent execution, ~4K lines. Created by a single developer as a personal assistant — the "small enough to understand" philosophy.

**Business model trajectory:** Currently open-source and self-hosted. If NanoClaw later adds hosted multi-tenant features, it could become an infrastructure-layer competitor (the GitLab / Supabase playbook).

| Aspect | NanoClaw | Garsson Harness |
|--------|----------|-----------------|
| Business model | Open-source, likely cloud SaaS | Closed-source harness + venture portfolio |
| Target user | Individual developer / power user | Domain operator running a vertical business |
| Isolation | Per-group (containers) | Per-case (containers + CRM + MCP) |
| Customer-facing | No (personal assistant) | Yes (router + work agents + bot swarm) |
| Multi-tenant | No | Yes (case isolation enables competitor companies on same vertical) |
| Monetization | Not yet clear | Direct revenue from vertical ventures |

**Threat assessment:** If NanoClaw launches a hosted offering with multi-tenant support, they'd be a credible infrastructure competitor with an open-source community advantage. Our differentiation would then be:
- Purpose-built for customer-facing verticals (they're general-purpose)
- Deeper isolation (case-level vs group-level)
- Venture portfolio model (we're the operator, not just the platform vendor)
- Domain operators as partners (they'd sell to developers, we partner with domain operators)

### 1.6 Ecosystem Summary

```
                        Customer-Facing Capability
                        Low ◄─────────────────► High

    Per-Case     │                              ★ Garsson Harness
    Isolation    │
                 │
    Per-Channel  │              Lobu
    Isolation    │
                 │
    Per-Operator │  OpenClaw    ClawSwarm
    Isolation    │  Praktor    NanoClaw
                 │
    None         │  ClawBot
                 │
```

No existing Claw ecosystem project combines customer-facing deployment with case-level isolation.

---

## 2. Commercial Platforms

### 2.1 Sierra AI

Purpose-built for customer-facing AI agents. Appears to be the closest commercial analog to what we're building.

| Aspect | Sierra AI | Garsson Harness |
|--------|-----------|-----------------|
| Agent Data Platform | Unified customer data across sessions, channels, systems | CRM MCP with per-customer scoping |
| Customer identity | Cross-channel identity resolution | 2FA-based identity merging |
| Memory/personalization | Built-in per-customer memory | Per-case session persistence |
| Deployment | Proprietary SaaS | Self-hosted, open-source |
| Isolation model | Application-level (proprietary) | OS-level containers |
| Customization | Configuration within their platform | Full code control (fork + modify) |
| Pricing | Enterprise contracts | Self-hosted (API costs only) |

**Key insight:** Sierra's Agent Data Platform is the most mature approach to customer data unification we've seen. Their per-customer memory and personalization model is worth studying for our CRM design. But it's a closed platform — no self-hosting, no code access, no container-level isolation guarantees.

### 2.2 Salesforce Agentforce

AI agents built on Salesforce's CRM data layer. Atlas Reasoning Engine for autonomous reasoning.

| Aspect | Agentforce | Garsson Harness |
|--------|------------|-----------------|
| Data model | Salesforce CRM (structured + unstructured) | Custom CRM via MCP |
| Tenant isolation | Inherited from Salesforce platform | Container + CRM MCP scoping |
| Agent autonomy | Policy-constrained actions | Role-based tool restriction |
| Ecosystem | 450+ integrations via Salesforce | MCP tools (extensible) |
| Lock-in | Full Salesforce ecosystem | None (open-source, self-hosted) |

**Key insight:** Agentforce shows that CRM-native AI agents work well — the data layer is already tenant-isolated. Our challenge is building equivalent tenant isolation without an existing enterprise CRM platform underneath.

### 2.3 ServiceNow AI Agents

Multiple specialized agents working together (orchestrator pattern). AI Control Tower for oversight. 450+ integrations.

| Aspect | ServiceNow | Garsson Harness |
|--------|------------|-----------------|
| Agent pattern | Orchestrator + specialists | Router + case workers |
| Data isolation | Inherited from ServiceNow platform | Container + CRM MCP |
| Oversight | AI Control Tower | Kaizen feedback loop + admin approval for dev cases |
| Target market | Enterprise IT service management | Small business / vertical-specific |

### 2.4 Intercom Fin / Zendesk AI / Ada / Forethought

Conversational AI for customer support. Ticket/conversation-scoped.

| Aspect | These platforms | Garsson Harness |
|--------|----------------|-----------------|
| Isolation model | Application-level (DB row filtering) | OS-level (containers) |
| Per-case isolation | No — shared model context across conversations | Yes — separate container, session, filesystem |
| Agent autonomy | Answer questions, escalate to humans | Full case execution (research, file processing, API calls) |
| Customization | Configuration UI | Full code control |
| Data access | Read from knowledge base + CRM | Read/write CRM, scratch files, internet |

**Key difference:** These platforms primarily rely on application-layer scoping — tenant-aware retrieval, policy engines, and authorization layers. This is often legitimate for their use case, but we do not have evidence of equivalent physically separate execution environments per work item.

### 2.5 Commercial Summary

```
                         Isolation Strength
                         App-Level ◄───────► OS-Level

    Full Customer    │  Sierra, Agentforce        ★ NanoClaw (planned)
    Platform         │  ServiceNow
                     │
    Conversational   │  Intercom, Zendesk
    Support          │  Ada, Forethought
                     │
    Dev/Internal     │                            Praktor
    Only             │
```

Commercial platforms have strong customer data platforms but primarily rely on application-level isolation. We have not found another project combining OS-level isolation with customer-facing case management.

---

## 3. Infrastructure & Sandbox Projects

### 3.1 Kubernetes Agent Sandbox (kubernetes-sigs)

Google-backed CRD for Kubernetes. Manages isolated, stateful, singleton workloads for AI agent runtimes. Supports gVisor and Kata Containers for kernel-level isolation.

**Relevance:** If NanoClaw ever needs to scale beyond single-host Docker, this is the Kubernetes-native standard for agent isolation. Not a competitor — a potential infrastructure layer.

### 3.2 AWS Multi-Tenant Agent Architecture Guide

Amazon's prescriptive guidance on tenant isolation for agentic AI. Covers: agent-per-tenant vs shared-agent models, data isolation patterns, credential management, guardrails.

**Relevance:** The most thorough architectural reference for multi-tenant agent design. Their "agent-per-tenant with shared infrastructure" pattern is closest to our model. Worth reading for the CRM MCP server design.

### 3.3 Kortix/Suna

Open-source agent platform with isolated Docker execution per agent instance. Browser automation, code interpreter, file system access.

**Relevance:** Similar container isolation approach but no customer-facing features, no case management, no CRM integration.

---

## 4. What Appears Differentiated

Based on this survey, the following aspects of the harness architecture appear uncommon in combination:

| Capability | Who else does it? | Our approach |
|-----------|-------------------|--------------|
| **Case-level OS isolation** (container per work item, not per channel/tenant) | Not seen in surveyed projects | Each case gets its own container with only that case's data mounted |
| **Three agent roles with distinct trust boundaries** | ServiceNow has multiple agent types, but with app-level isolation | Router (intake only), work (per-case CRM), dev (code only). OS-level enforcement per role. |
| **Customer CRM binding at container boundary** | Sierra does this at app level | CRM MCP server rejects queries for wrong customer. OS-level + data-level + capability-level enforcement. |
| **Kaizen feedback loop in case lifecycle** | Not seen in surveyed projects | Case completion triggers reflection → suggested dev improvements → better tooling → better case outcomes. Example: a recurring quoting mistake becomes a vertical-level prompt fix; a repeated payment-status lookup becomes a harness-level integration. |
| **Harness/vertical architecture** | Not seen in the Claw ecosystem | Closed harness + private vertical repos mounted into containers. Domain code separated from infrastructure. |

The individual techniques aren't new (containers, CRM scoping, named bots). The combination and the depth of isolation enforcement is what appears uncommon. These boundaries are enforced at different layers: runtime/container isolation, tool-level access control, and workflow/role-level capability restriction.

---

## 5. What We Should Learn From

| Source | What to study | Applies to |
|--------|---------------|-----------|
| **Sierra AI — Agent Data Platform** | How they unify customer data across sessions and channels. Their memory/personalization model. | CRM MCP server design |
| **Lobu — REST API for agent provisioning** | Programmatic agent creation and per-channel isolation patterns | Bot-case assignment, agent lifecycle management |
| **AWS multi-tenant agent guide** | Agent-per-tenant vs shared-agent tradeoffs, credential management, guardrails | Overall architecture validation |
| **Kubernetes Agent Sandbox** | CRD patterns for stateful agent workloads, gVisor/Kata isolation | Future scaling beyond single-host Docker |
| **Praktor — Mission Control UI** | Operator visibility into agent swarm state | Future monitoring/management UI |
| **Salesforce Agentforce — Atlas Engine** | Policy-constrained agent autonomy, how they limit what agents can do | MCP tool restriction by role |

---

## 6. What Must Be Built

The critical-path components that do not yet exist:

- **CRM MCP server**: Per-customer data scoping at the container boundary. This is the hardest component — it must enforce tenant isolation without an enterprise CRM platform underneath. Without it, case isolation is a runtime boundary only, not a data boundary.
- **Customer identity resolution**: Merging identities across channels (WhatsApp number + Telegram handle + email = one customer). Currently manual.
- **Agent control plane**: Monitoring, cost tracking, and operational visibility across concurrent cases. Currently ad-hoc.
- **Multi-vertical deployment**: Running multiple verticals on the same harness instance with separate data stores. Currently single-vertical.

Containerization is already built. The isolation enforcement layers above it are the real work.

---

## 7. Tradeoffs and Costs

This architecture is not free, and it is not right for every use case.

- **Per-case containers are expensive.** Each case gets its own container, model context, and session. For high-volume, low-complexity interactions (FAQ bots, simple lookups), this is overkill. The architecture is designed for multi-step, data-sensitive workflows — not chat.
- **Domain operators are a bottleneck.** The model requires finding and retaining domain operators for each vertical. Scaling depends on people, not just code. If the right operator doesn't exist for a vertical, the vertical doesn't happen.
- **Single-host limits scale.** The current architecture runs on one machine. Horizontal scaling (Kubernetes, multi-region) is a future problem, but it is a real one.
- **Upstream maintenance has a cost.** Keeping NanoClaw as upstream means merging changes, resolving conflicts, and maintaining compatibility with a codebase that has different goals. This cost grows as the harness diverges.
- **The CRM is the critical risk.** Everything downstream of case isolation depends on scoped data access. If the CRM MCP server is too slow, too rigid, or too hard to integrate with real business data, the architecture falls apart at the most important layer.

---

## 8. Four Reinforcing Wedges

- **Technical wedge**: Case-level isolation plus scoped access make customer-facing agent deployment safer and more trustworthy in sensitive, multi-company workflows.
- **Commercial wedge**: Domain operators bring trust, workflow knowledge, and escalation judgment that small businesses will not buy from a generic software sales motion.
- **Market wedge**: Under-served local and niche verticals are too small individually for large platforms to prioritize, but large enough in aggregate to support a portfolio.
- **Operational wedge**: Recursive kaizen — every case completion triggers reflection, surfacing improvements that flow back into tooling. Each deployment makes the next one faster and more reliable.

The model works only if these wedges reinforce each other: stronger isolation enables multi-company deployment, domain operators make adoption possible, niche markets provide a wedge global platforms often ignore, and recursive improvement compounds the advantage over time.

---

## 9. Business Model

### What We're Building

Garsson Harness is not a SaaS platform, not an open-source framework, and not a consulting practice. It's a **closed-source harness that powers a portfolio of vertical ventures**.

Each venture is a partnership between Garsson (harness + infrastructure) and a **domain operator** who knows the industry. The domain operator brings domain knowledge; the harness brings agent orchestration, case isolation, CRM, and multi-tenant security.

### Ramp Per Vertical

Each new vertical follows a three-stage ramp, where each stage validates the next:

```
Stage 1: Domain operator uses agents to run their own work faster
  → Validates: harness works for this vertical, discovers needed tools/workflows
  → Example: Nir uses agents for his own printing workshop operations

Stage 2: Domain operator + agents manage one company (humans + agents)
  → Validates: case isolation works with real customers, agent swarm handles concurrent cases
  → Example: Nir's workshop serves customers via Telegram bots + email, agents handle intake/quoting/tracking

Stage 3: Domain operator onboards other companies in the same vertical
  → Validates: multi-tenant isolation, vertical is a platform not a one-off
  → Example: Other printing workshops use the same vertical, each with isolated customer data
```

### Why This Model Works

| Advantage | Explanation |
|-----------|-------------|
| **Domain expertise is provided by partners** | Domain operators bring customer acquisition/trust, workflow knowledge, escalation judgment, and local/regulatory fluency. Garsson does not need to internalize every vertical's operational knowledge — the vertical repo encodes it. |
| **Infrastructure is shared** | Every venture runs on the same harness. Case isolation, CRM, agent swarm, channels — built once, used by all. |
| **Each venture validates the harness** | Stage 1 discovers missing tools. Stage 2 stress-tests isolation. Stage 3 proves multi-tenancy. Every vertical makes the harness better for all verticals. |
| **Isolation enables multi-tenancy** | The case isolation spec (container per case, CRM scoping, MCP restriction) is what makes Stage 3 possible. Without it, Company A's data leaks to Company B — and in a vertical, companies are competitors. |
| **Low marginal cost per venture** | Adding a new vertical = new private repo + new domain operator. No new infrastructure, no new harness code (unless the vertical surfaces a gap, which becomes a kaizen dev case). |

### How This Differs From Competitors

| Model | Who does it | How we differ |
|-------|------------|---------------|
| **SaaS platform** (Sierra, Agentforce) | Customer buys a subscription, configures within the platform's constraints | We own the ventures. Domain operators are partners, not customers. Full code control, not configuration. |
| **Open-source framework** (OpenClaw, NanoClaw) | User forks, customizes, self-hosts | Closed-source harness. The isolation and orchestration layers are proprietary IP. |
| **AI consultancy** | Build custom solutions per client | We build a reusable harness, not bespoke projects. Each vertical is a repeatable business, not a one-time engagement. |
| **Vertical SaaS** (traditional) | One company, one vertical, one product | We're a venture studio with a shared harness. Multiple verticals, each with its own domain operator. |

The closest analogy is a **franchise model for AI agents**: Garsson provides the infrastructure (harness), the domain operator provides the domain knowledge (vertical), and together they serve an industry.

---

## 10. Strategic Assessment

### Garsson Harness vs NanoClaw

This analysis makes clear that what we're building is no longer a NanoClaw customization — it's a new product. NanoClaw is a personal assistant framework: one user, stateless containers, no customer concept, no case isolation. Garsson Harness is a customer-facing agent platform with case-level OS isolation, CRM-scoped data access, role-based trust boundaries, and named agent swarms.

The harness uses NanoClaw as its upstream foundation (channels, container runtime, message loop) but the value is in the layers above: case isolation, CRM integration, agent roles, bot identity routing, vertical architecture. These are proprietary differentiators, not upstream contributions.

Strategy:
- **NanoClaw remains upstream** for infrastructure (channels, container runtime, basic agent lifecycle)
- **Garsson Harness is the product** — case isolation, CRM, agent swarm, vertical deployment
- **Future direction**: As the gap widens, maintaining upstream compatibility becomes a cost rather than a benefit. A clean break (rename, closed-source) is likely.

### Strengths

- **Enforcement across layers**: Isolation enforced at runtime (container), data (CRM MCP), capability (MCP tools), and branch (worktree) levels — not just one boundary
- **Venture portfolio model**: Shared harness across verticals means each venture improves the platform for all
- **Domain-operator distribution**: Domain operators bring industry knowledge, customer trust, and local fluency; Garsson builds infrastructure
- **Compounding learning**: Recursive kaizen means each deployment feeds improvements back into the harness
- **Stage-gated validation**: Each venture ramps through proven stages before scaling

### Weaknesses

- **CRM doesn't exist yet**: The CRM MCP server is the critical path component and hasn't been built
- **Single-host**: No clustering or horizontal scaling story yet
- **Small team**: Limited bandwidth for both harness development and venture support
- **Unproven at scale**: No production deployment with real paying customers yet (Stage 1 in progress with prints vertical)
- **Domain operator dependency**: Each vertical requires finding and partnering with the right domain expert

### Opportunities

- **Early mover in OS-level case isolation**: We have not found another open-source or commercial project offering container-per-case isolation with CRM scoping
- **Vertical expansion**: Every industry with customer service + data sensitivity is a potential venture (insurance, legal, healthcare, financial services)
- **Compounding returns**: Each vertical hardens the harness, surfaces missing tools, and validates the model — making the next vertical faster to launch
- **Window to build operational depth**: Keeping the source closed may buy time, but the moat is operational, not merely legal

### Threats

- **OpenClaw Agents Plane**: If OpenClaw ships native multi-tenant support, their ecosystem advantage could commoditize the infrastructure layer
- **Lobu expansion**: If Lobu adds case-level isolation, they'd compete directly with a larger community
- **Commercial platforms moving downmarket**: Sierra, Agentforce becoming accessible to small businesses
- **Upstream divergence cost**: Maintaining NanoClaw compatibility while building proprietary layers creates ongoing merge overhead
- **Venture execution risk**: Each vertical is a new business — product-market fit, domain operator reliability, and customer acquisition are independent risks per venture

---

The defensibility is not that we run containers. It is that we can repeatedly deploy a constrained, scoped, operator-assisted automation system into messy verticals faster than others can localize, integrate, and operationalize it.
