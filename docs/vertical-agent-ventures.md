# Case-Level Isolation in Customer-Facing Agent Platforms

Status: **Draft** | Date: 2026-03-18

Related: [Case Isolation Spec](case-isolation-spec.md) | [kaizen#65](https://github.com/Garsson-io/kaizen/issues/65)

---

## 1. Thesis

Most customer-facing agent platforms assume application-layer isolation is enough. Garsson Harness is betting that for some vertical workflows, it is not. The required primitive is **case-level execution isolation**: a work item gets its own execution environment, scoped data access, and bounded capabilities.

The point is not only safety. It is operational separation that makes multi-company vertical deployment possible — a reusable harness for multiple ventures, each run by a domain operator who brings industry expertise while the harness provides infrastructure, isolation, and agent orchestration.

This document surveys existing systems to test that thesis: who else solves the isolation problem, who solves it differently, where are they stronger, and where does our approach appear differentiated.

**The thesis is wrong if** shared application-layer systems can safely and reliably handle the target workflows at lower cost and complexity — including document processing, artifact generation, and multi-company deployment within a single vertical where companies are direct competitors.

### What "case isolation" means

A case is a single work item for a single customer. Case isolation means:

- **Isolated execution environment**: separate container per case (OS-level process/filesystem boundary)
- **Isolated session and memory**: separate LLM context, no cross-case context bleed
- **Isolated customer-scoped data access**: agent can only query CRM data for its assigned customer, enforced by the data layer
- **Isolated filesystem and artifacts**: separate scratch directory, no access to other cases' working files
- **Isolated credentials and capabilities**: different agent roles receive different MCP tools and permissions
- **Lifecycle tied to one work item**: container created when case starts, destroyed when case completes

### The isolation ladder

Not all isolation is equal. Systems can be roughly placed on a ladder:

| Level | Typical separation | Representative examples |
|-------|-------------------|------------------------|
| **Shared platform** | Nothing — all agents share context | Basic chatbot deployments |
| **Per-tenant isolation** | Each organization gets its own data partition | Enterprise CRM-native agents (e.g., Salesforce, ServiceNow) |
| **Per-customer isolation** | Each end-customer's data is scoped | Application-level scoping in customer-facing platforms (e.g., Sierra AI) |
| **Per-case isolation** | Each work item gets its own execution environment, session, and data scope | Garsson Harness (planned) |

Per-case is stricter than per-customer because a single customer may have multiple concurrent cases. Without case-level separation, an agent working on Customer A's billing dispute could see context from Customer A's unrelated insurance claim — leading to hallucinated cross-references, leaked details between cases, or simply confused reasoning.

### Why case isolation matters: concrete scenarios

- **Competing companies on the same vertical**: A printing workshop and its competitor both use the same Garsson vertical. An agent processing Workshop A's order must never access Workshop B's pricing, customer list, or pending orders. The goal is to make unrelated case data unavailable by default at the execution, filesystem, and tool-access layers, rather than relying only on filtering inside a shared application context.
- **Concurrent cases for one customer**: Customer asks about a refund (Case 1) while also requesting a new quote (Case 2). Two different agents work these simultaneously. Without case isolation, the quoting agent might reference the refund dispute — confusing the customer or leaking negotiation context.
- **Sensitive document processing**: One case involves processing a medical referral PDF. Another is a routine status check. The status-check agent should never have the medical document in its filesystem or context window, even if both cases belong to the same customer.

---

## 2. Why This Market May Be Open Now

Many service-heavy verticals spend relatively little on software compared with payroll, coordination, and exception-handling. The value pool is not mainly SaaS budget — it is operator time.

Historically, much of this work remained unautomated because the workflows were too messy and too specific. Traditional automation required too much bespoke setup, integration work, and maintenance to make economic sense for small and mid-sized businesses. A printing workshop, an insurance brokerage, a small logistics company — each has complex operational workflows, but none could justify custom software development.

Agent systems may change that cost curve. If the cost of tailoring automation falls enough, many previously unreachable workflows become viable targets: document handling, quoting, intake, follow-ups, routing, status checks, exceptions, and back-office coordination. The open-source agent ecosystem suggests that once the setup burden is reduced, many useful workflow automations become feasible for non-technical operators.

The key question is no longer whether agents can do useful work at all — they clearly can in many bounded workflows. The remaining barriers are setup complexity, security, isolation, and the cost of tailoring agents to specific business processes. That is what the harness is designed to solve.

This is not a thesis about winning generic support chat. It is a thesis about exception-heavy, document-heavy, multi-step workflows where shared application-layer architectures are weaker and tailored automation has historically been too expensive.

Most small businesses will not build this automation themselves. They lack the technical capacity. They are vulnerable to larger players that can spread automation costs across many customers or locations. The opportunity is to provide the automation harness, partner with a domain operator who knows the industry, and help small businesses in the vertical survive, reduce costs, and stay competitive — while keeping their best operators as humans-in-the-loop experts where judgment and trust matter.

### Under-served local markets as go-to-market wedge

Large global vendors often underinvest in markets like Israel. Localization across language, regulatory environment, financial systems, and business culture is often shallow or economically unattractive. Competition is often primarily local.

This is not just an observation — it is a go-to-market wedge. A vertical tuned for the Israeli printing industry has no global competitor, because no global company has invested in localizing for that specific intersection of language, regulation, and business norms. Similar dynamics likely exist in many small-to-medium markets worldwide.

Each such market may look too small in isolation to attract a platform. But the sum of many niche deployments — each using the same harness with a local domain operator — may be larger and more defensible than trying to build one giant company in one large market. The harness is the common factor; the domain operator and local market specifics are the variables.

---

## 3. Survey

We looked at three categories: open-source agent frameworks, commercial customer-facing platforms, and infrastructure/sandbox projects. For each, we focused on isolation model, customer-facing capability, and business model.

### 3.1 Open-Source Agent Frameworks

These are operator-facing tools. They help developers run agents, not serve end-customers.

#### OpenClaw

Appears to be the largest open-source AI agent project (~7,000 GitHub stars as of this writing). Multi-channel (Slack, Discord, Telegram, WhatsApp, webchat). The official docs state it is "not designed as a hostile multi-tenant security boundary for multiple adversarial users sharing one agent/gateway."

The team was acquired by NVIDIA (Nemoclaw). The open-source project appears optimized for adoption and community-building; NVIDIA's interest is likely in the broader AI agent infrastructure play.

**Relevant development:** OpenClaw issue #17299 proposes an "Agents Plane" for native multi-tenant agent provisioning. Not yet implemented — suggests the community recognizes the gap.

**Where OpenClaw is stronger:** Ecosystem (70+ integrations, large community), maturity, breadth of channel support, enterprise visibility via NVIDIA.

**Where it does not appear to solve our problem:** No per-case or per-customer isolation. No case lifecycle. No CRM scoping. Application-level permissions rather than OS-level boundaries.

#### Lobu

Multi-tenant wrapper for OpenClaw. Seems closest to customer-facing deployment in the Claw ecosystem. Provides per-channel/DM isolation with sandboxed execution, REST API for programmatic agent creation, MCP proxy with OAuth and network isolation.

**Where Lobu is stronger:** REST API for agent provisioning is more mature than our MCP+IPC approach. Larger community through OpenClaw ecosystem.

**Where it does not appear to solve our problem:** Isolates per channel, not per work item. If a customer has two concurrent issues, they share the same isolation boundary. No case lifecycle, no CRM integration, no customer identity model.

#### NanoClaw (our upstream)

Lightweight, security-focused alternative to OpenClaw. One Node.js process, container-isolated agent execution, ~4K lines. Created as a personal assistant — "small enough to understand."

If NanoClaw later adds hosted multi-tenant features (following the common L1 open-source → L2 cloud SaaS playbook), it could become an infrastructure-layer competitor.

**Where NanoClaw is stronger:** Simplicity, auditability, container isolation as a first-class design principle, active open-source community.

**Where it does not appear to solve our problem:** Per-group isolation (not per-case). No customer concept. No CRM integration. No agent roles. Designed for a single operator, not customer-facing deployment.

#### ClawSwarm / Praktor

ClawSwarm focuses on multi-agent collaboration (director → specialists), not customer isolation. Praktor is a Claude Code orchestrator with Docker isolation and a Mission Control UI — closer to dev tooling than customer-facing work.

**Worth studying:** Praktor's Mission Control UI for operator visibility. ClawSwarm's hierarchical delegation pattern.

#### Open-source summary

As far as this survey found, no open-source agent framework combines customer-facing deployment with per-case execution isolation. Most optimize for operator experience. The ones that address multi-tenancy (Lobu) do so at the channel level, not the work-item level.

### 3.2 Commercial Customer-Facing Platforms

These are genuine product competitors in the customer-facing space. They have stronger data platforms but different isolation models.

#### Sierra AI

Appears to be the clearest commercial example of a purpose-built customer-facing AI agent platform. Their Agent Data Platform unifies customer data across sessions, channels, and backend systems.

**Where Sierra is stronger:** Mature customer data platform, cross-channel identity resolution, enterprise-grade memory and personalization, production deployments with real customers. They have solved many of the problems we have not yet built (CRM, identity, observability).

**Where it does not appear to solve our technical problem:** Proprietary SaaS — no self-hosting, no code access. Isolation model appears to be application-level (we do not have evidence of container-per-case isolation).

**Where it does not match our operating model:** Not designed for domain-operator-led vertical ventures.

#### Salesforce Agentforce / ServiceNow AI Agents

AI agents built on top of existing enterprise CRM/ITSM platforms. Tenant isolation is inherited from the platform — strong, but tied to the platform ecosystem.

**Where they are stronger:** Mature multi-tenant data platforms with years of production hardening. Hundreds of integrations. Enterprise sales and support.

**Where they do not appear to solve our technical problem:** Agent isolation is inherited from the platform's tenant model, not enforced per case.

**Where they do not match our operating model:** Full ecosystem lock-in. Not designed for small businesses or independent vertical operators.

#### Intercom Fin / Zendesk AI / Ada / Forethought

Conversational AI for customer support. Ticket/conversation-scoped.

These platforms primarily rely on application-layer scoping rather than physically separate execution environments. They use authz layers, tenant-aware retrieval, policy engines, and prompt boundaries — which is a legitimate and often effective approach for their use case (answering questions, escalating to humans). We do not have evidence of container-per-case isolation in any of these.

**Where they are stronger:** Production-proven, large customer bases, mature escalation workflows, pre-built integrations with support tools.

**Where they do not appear to solve our problem:** Agents primarily answer questions rather than executing multi-step work with file access. Isolation is at the application layer. Not designed for cases where an agent processes sensitive documents or produces artifacts that must not bleed across tasks.

#### Commercial summary

Commercial platforms gain their isolation strength from the data platforms they're built on (Salesforce's CRM, ServiceNow's ITSM). This is effective but creates ecosystem lock-in. We did not find a commercial platform that offers OS-level per-case isolation. This may be because their application-layer approach is sufficient for their use cases — the question is whether it is sufficient for ours.

### 3.3 Infrastructure & Sandbox Projects

These are not competitors but potential building blocks or architectural references.

- **Kubernetes Agent Sandbox (kubernetes-sigs)**: Google-backed CRD for isolated agent workloads. Supports gVisor and Kata Containers. Relevant if we need to scale beyond single-host Docker.
- **AWS Multi-Tenant Agent Architecture Guide**: The most thorough reference we found for multi-tenant agent design patterns. Their "agent-per-tenant with shared infrastructure" pattern is closest to our model.
- **Kortix/Suna**: Open-source agent platform with Docker isolation per instance. Similar container approach but no customer-facing features or case management.

---

## 4. What Must Be Built

The runtime isolation primitive exists. The hard part is everything above it:

| Component | Why it's hard | Current state |
|-----------|---------------|--------------|
| **CRM MCP server with per-customer access control** | This is where "safe scoped access" lives. It's the control plane, not the runtime, that makes case isolation useful. Without it, agents have isolated containers but no useful data access. | Does not exist. This is the critical path. |
| **Customer identity resolution** | Linking channel identities (Telegram user, email address) to a canonical customer ID. Cross-channel identity merging with verification. | Schema designed, not implemented. |
| **Session persistence across container recycling** | Claude's `--resume` handles conversation context, but scratch files, CRM state, and in-progress operations must all survive container teardown. | Partially solved (session files per group exist; extending to per-case is straightforward). |
| **Agent lifecycle management** | Warm/cold container decisions, idle timeout, concurrent case limits, bot-to-case assignment, mechanistic responses for unavailable agents. | Conceptual design exists. Implementation pending. |
| **Observability and debugging** | Distributed state across containers. How does an operator understand what's happening across 5+ concurrent cases? | Nothing built. Praktor's Mission Control UI is a reference. |
| **Vertical configuration contract** | What lives in the harness vs the vertical repo. How verticals declare their workflows, tools, and escalation policies. | Partially exists (escalation.yaml, materials.json). Needs formalization. |

Containerization is the easy part. Safe scoped data access and identity resolution are the hard part. The control plane is likely more strategic than the runtime.

---

## 5. What Appears Differentiated

We avoid claiming novelty. The individual techniques are well-known (containers, CRM scoping, role-based access). What appears uncommon is the specific combination and the depth of enforcement at each layer.

**Execution and isolation:**

| Capability | Nearest comparable | How our approach differs |
|-----------|-------------------|------------------------|
| **Container per case** (not per channel or per tenant) | Lobu (per-channel), Praktor (per-invocation) | Lifecycle-bound: container tied to a work item, not a conversation or a channel |
| **Role-based agent types with OS-level enforcement** | ServiceNow (multiple agent types, app-level) | Router / work / dev have different container mounts, different MCP tools, different credentials. The separation is in what's physically available, not just what's instructed. Benefit: tighter blast radius, cheaper models for intake, clearer escalation paths |

**Control plane and access model:**

| Capability | Nearest comparable | How our approach differs |
|-----------|-------------------|------------------------|
| **Customer-scoped CRM at the MCP boundary** | Sierra (app-level scoping) | The MCP server enforces access control — agent cannot query other customers' data at the tool level, not just the prompt level |

**Operating model:**

| Capability | Nearest comparable | How our approach differs |
|-----------|-------------------|------------------------|
| **Harness/vertical separation** | We did not find an equivalent in the survey | Domain code (vertical repo) separated from infrastructure (harness). Allows multiple competing companies on the same vertical with the same harness. |
| **Recursive kaizen** | We did not find an equivalent | Case completion triggers structured reflection → suggested improvements. Day-to-day operations feed improvements upward: company-level → vertical-level → harness-level. The system also applies kaizen to itself (recursive kaizen: getting better at getting better). This is an operational learning mechanism, not just a feature. |

### What is not a differentiator

- **Small codebase**: Nice for auditability but not a moat. A small orchestrator with complex surrounding infrastructure is not necessarily simpler in practice.
- **Bot identity as routing**: A useful implementation detail that reduces dependence on probabilistic routing. An optimization, not a moat.

---

## 6. Tradeoffs and Costs

Our approach likely trades simplicity, resource efficiency, and operational maturity for stronger execution isolation and clearer trust boundaries. Container-per-case is not free:

| Cost | Description |
|------|-------------|
| **Container startup latency** | Each new case pays a cold-start cost. Active cases kept warm, but idle cases that resume pay again. |
| **Resource density** | One container per active case means memory and CPU scale linearly with concurrent cases. Application-layer systems can serve many cases from one process. |
| **Orchestration complexity** | Container lifecycle management, health checks, idle timeout, session persistence across recycles — all must be built and maintained. |
| **Observability** | Debugging across multiple isolated containers is harder than debugging within a single application process. Logs, traces, and state are distributed. |
| **CRM control plane** | Application-layer platforms inherit tenant isolation from their data platform. We must build equivalent isolation from scratch in the CRM MCP server. |
| **Persistence model** | State must survive container recycling — session files, scratch directories, CRM data all need explicit persistence strategies. |

This architecture is probably wrong for lightweight support chat, FAQ answering, and high-volume low-complexity interactions where application-layer isolation is sufficient and more efficient. It becomes more attractive when cases involve processing customer documents, producing artifacts, executing multi-step workflows, or operating across competing companies sharing infrastructure.

---

## 7. What We Should Learn From

| Source | What to study | Applies to |
|--------|---------------|-----------|
| **Sierra AI — Agent Data Platform** | How they unify customer data across sessions and channels. Their memory and personalization model. | CRM MCP server design |
| **Lobu — REST API for agent provisioning** | Programmatic agent creation, per-channel isolation patterns | Bot-case assignment, agent lifecycle |
| **AWS multi-tenant agent guide** | Agent-per-tenant vs shared-agent tradeoffs, credential management, guardrails | Architecture validation |
| **Kubernetes Agent Sandbox** | CRD patterns for stateful agent workloads, gVisor/Kata isolation | Future scaling path |
| **Praktor — Mission Control UI** | Operator visibility into agent swarm state | Observability |
| **Salesforce Agentforce** | Policy-constrained agent autonomy, how they limit agent actions | MCP tool restriction by role |

---

## 8. Business Model

### The venture portfolio model

Garsson Harness is not a SaaS platform, not an open-source framework, and not a consulting practice. It is a closed-source harness that powers a portfolio of vertical ventures.

Each venture is a partnership between Garsson (harness infrastructure) and a **domain operator** — someone who knows the industry and contributes:

- **Customer acquisition**: existing relationships and trust in the vertical
- **Workflow knowledge**: how the business actually runs, including exceptions and edge cases
- **Escalation judgment**: when human intervention is needed and what "good enough" looks like
- **Local and regulatory fluency**: language, compliance, payment systems, business norms

The harness brings agent orchestration, case isolation, CRM, and multi-tenant security. The domain operator brings everything the harness cannot know.

### Four wedges

The strategy rests on four reinforcing wedges:

- **Technical wedge**: Case-level isolation plus scoped access — the architecture that makes multi-company deployment safe.
- **Commercial wedge**: Domain-operator-led deployment — small businesses adopt automation through a trusted industry peer, not through a software sales process.
- **Market wedge**: Under-served local and niche verticals — too small individually for global platforms, collectively large enough to build a portfolio.
- **Operational wedge**: Recursive kaizen — every case that runs feeds improvements upward (company → vertical → harness), and the system applies kaizen to itself (getting better at getting better). This is compound interest applied to operational learning. A competitor that starts later doesn't just have less code — they have less accumulated operational knowledge at every level.

### Ramp per vertical

Each new vertical follows a three-stage ramp. Each stage validates the next before scaling:

```
Stage 1: Domain operator uses agents to accelerate their own work
  → Validates: harness works for this vertical, discovers needed tools/workflows
  → Example: Nir uses agents for his own printing workshop operations

Stage 2: Domain operator + agents manage one company (humans + agents serving real customers)
  → Validates: case isolation works with real customers, agent swarm handles concurrent cases
  → Example: Nir's workshop serves customers via Telegram bots + email

Stage 3: Domain operator onboards other companies in the same vertical
  → Validates: multi-tenant isolation (competing companies on same infrastructure)
  → Example: Other printing workshops use the same vertical, each with isolated customer data
```

### How this differs from other models

| Model | Example | Key difference |
|-------|---------|---------------|
| **SaaS platform** | Sierra, Agentforce | They sell subscriptions. We own ventures with domain operator partners. |
| **Open-source framework** | OpenClaw, NanoClaw | Frameworks for developers and operators; monetization typically comes later via hosting, enterprise features, or adjacent businesses. Our isolation and orchestration layers are proprietary. |
| **AI consultancy** | Accenture, Deloitte AI | They build bespoke solutions. We build a reusable harness — each vertical is a repeatable business. |
| **Vertical SaaS** | Toast, Veeva | One company, one vertical. We're a venture studio with a shared harness across verticals. |

### Why the business model depends on case isolation

Case isolation is not just a security feature. It is the enabling primitive for Stage 3. Without it, Company A's data can leak to Company B — and in a vertical, companies are direct competitors. The isolation spec (container per case, CRM scoping, MCP restriction) is the mechanism that enables multi-tenant vertical deployment. Without it, you can run one company per harness instance. With it, you can run many.

---

## 9. Strategic Assessment

### What must be true for this model to work

1. **Case-level isolation must be achievable at reasonable cost.** If container-per-case is too expensive or too slow for real customer interactions, the architecture doesn't hold. The CRM MCP server must provide useful scoped access, not just empty sandboxes.
2. **Domain operators must exist and be willing to partner.** Each vertical depends on finding someone with industry knowledge who wants to build a business on this harness.
3. **The harness must compound.** Each vertical must make the harness better for all verticals. If every vertical requires heavy custom harness work, it's consultancy, not a platform.
4. **Application-layer isolation must be insufficient for our target workflows.** If prompt engineering + DB filtering works well enough for sensitive customer-facing work — including document processing, artifact generation, and multi-company deployment — our per-case isolation is overengineered. This is the core empirical question. The bet is that it isn't enough, especially for multi-company verticals where companies are direct competitors.
5. **Small businesses must be reachable through domain operators, not direct sales.** These businesses won't buy agent infrastructure. They'll adopt it if a trusted industry peer (the domain operator) makes it easy and relevant.
6. **Geographic and regulatory niches must be durable moats.** If a global platform decides to localize for Israel or similar markets, the niche advantage disappears. The bet is that these markets are too small to attract that investment — individually. The portfolio of many such niches is the defense.

### What breaks first as scale increases

- **Container density**: At some point, one host can't run enough concurrent cases. Need a scaling story (Kubernetes, multi-host).
- **CRM performance**: If every agent action queries the CRM MCP, the CRM becomes a bottleneck. Need caching, connection pooling, maybe local replicas.
- **Operator visibility**: With 20+ concurrent cases across 3 verticals, how does anyone know what's happening? Need observability tooling.
- **Domain operator coordination**: Multiple ventures means multiple partners with different needs, timelines, and expectations. Need governance.

### Where the moat compounds

- **Operational learning**: Every case that runs teaches the harness something (via kaizen). Improvements flow to all verticals.
- **Vertical configuration library**: Each vertical's config (escalation policies, workflows, tool definitions) becomes a reusable template for similar industries.
- **Isolation enforcement depth**: As the CRM, identity model, and MCP tooling mature, the gap between our isolation and application-layer alternatives widens.
- **Domain operator network**: Successful ventures attract more domain operators.
- **Local market accumulation**: Each under-served market that gets a vertical deployment is a wedge that global vendors are unlikely to contest. The portfolio of niches compounds while each individual market remains too small to attract competition.

### What gets commoditized if upstream catches up

If NanoClaw (or OpenClaw, or another framework) adds multi-tenant support with case-level isolation:
- The container runtime becomes a commodity
- The channel integrations become a commodity
- The basic agent lifecycle becomes a commodity

What remains defensible:
- The CRM control plane with per-customer scoping (hard to build, specific to our model)
- The venture portfolio and domain operator partnerships (business relationships, not code)
- Vertical-specific configurations and operational knowledge (built through Stages 1-3)
- The kaizen feedback loop and its accumulated improvements (operational discipline, not just architecture)

The defensibility is not that we run containers. It is that we can repeatedly deploy a constrained, scoped, operator-assisted automation system into messy verticals faster than others can localize, integrate, and operationalize it. Keeping the source closed buys time to build that capability, but is not itself the moat.
