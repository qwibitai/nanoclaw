# The Optimal Executive AI: A Complete Description

## What It Is

An ambient intelligence that wraps around your entire professional and personal life. It never sleeps, never polls, never waits for you to open a terminal. It perceives everything happening across your digital surfaces in real-time, maintains a deep structured understanding of your world, acts autonomously within calibrated trust boundaries, coordinates a team of specialized agents without you as the router, and learns from every interaction to get better every day.

It is not a chatbot. It is not an assistant you summon. It is an extension of your executive function — the part of your brain that tracks, prioritizes, remembers, follows up, connects dots, and catches things before they fall. You focus on what only you can do: the scientific thinking, the mentoring, the clinical judgment, the creative leaps. Everything else just happens.

## Lineage and Foundation

This system is the convergence of three existing implementations, each contributing a critical capability:

**Marvin** (`~/Agents/marvin2`) is the spiritual ancestor — the original AI Chief of Staff. It contributes: the session-based workflow (`/marvin`, `/marvin:end`, `/marvin:update`), the daily digest pipeline (`/marvin:digest`), the email triage system (Mac Mail AppleScript, Gmail API), the heartbeat auto-save pattern, the contact tracking framework (`content/collaborators/`), the self-improvement loop (`tasks/lessons.md`), the custom subagent architecture (NIH Reporter, dossier agent, deadline monitor, email triager, kb-search), the Granola meeting transcript integration, the promotion dossier workflow, and the deep Obsidian vault conventions. Marvin understands the *content* of Mike's professional life better than anything else.

**NanoClaw** (`~/Agents/nanoclaw`) contributes the runtime architecture — the part that makes agents always-on rather than summoned. It provides: container isolation (Apple Container Linux VMs), the credential proxy (secrets never enter containers), the Telegram channel system with agent swarm (pool bots for subagent identities), the IPC message bus (tasks, messages, and inter-group communication), the session management system (resume, expiry, compaction), the scheduled task framework (cron with validation), the MCP server integration layer (QMD, SimpleMem, Apple Notes, Todoist, Ollama, Gmail, bioRxiv, PubMed, Open Targets), the mount security allowlist, and the group-based isolation model where each team has its own filesystem, memory, and session.

**OpenClaw** (`~/Agents/openclaw` and `~/.openclaw`) contributes the agent platform layer — the infrastructure for running persistent agents at scale. It provides: the sandbox execution model, the subagent orchestration framework, the identity and authentication system, the delivery queue for reliable message routing, the cron subsystem, the canvas/workspace abstraction, the device management layer, and the extension architecture for adding channels and capabilities as plugins. OpenClaw understands how to run agents as *services* rather than as CLI sessions.

The optimal system takes all three and merges them into something none of them can be alone.

## Where It Runs

Locally on a Mac. Not in the cloud. The host machine is the orchestrator, the credential vault, the connection point to macOS-native services (Calendar via EventKit, Mail via AppleScript, Apple Notes, iCalBuddy), and the bridge to containerized agents. Local execution means: low latency for real-time perception, direct access to macOS APIs without cloud proxying, full control over data residency, and no dependency on external infrastructure beyond the LLM API itself.

The primary interface is **Telegram** — groups for each domain (LAB-claw, SCIENCE-claw, HOME-claw, CODE-claw), with the main DM for direct communication. Telegram provides: cross-device access (phone, desktop, tablet), push notifications with per-group control, bot identities for subagents via the swarm pool, media support (photos, voice memos, documents), and low-friction interaction from anywhere.

## The Knowledge Base

The core knowledge base is an **Obsidian-compatible vault** at `/Volumes/sandisk4TB/Dropbox/AGENTS/marvin-vault/`. Dropbox syncs it across machines. Obsidian provides the human interface for browsing, editing, and graph visualization. Agents read and write to it directly.

The vault follows a strict structure inherited from Marvin:

```
marvin-vault/
├── inbox/            Unsorted captures (triage queue)
├── daily/            Time-stamped notes
│   ├── journal/      Daily session summaries
│   ├── meetings/     Meeting notes (with 1v1/ for recurring)
│   └── talks/        Seminar and conference notes
├── projects/         Active research projects and grants
├── areas/            Ongoing responsibilities
│   └── people/       Collaborator and lab member profiles
├── lab/              Lab operations (admin, protocols, letters)
├── resources/        Reference material (bookmarks, email digests, paperpile)
├── wiki/             Curated research knowledge base
│   ├── papers/       Structured paper entries
│   ├── tools/        Bioinformatics tools
│   ├── datasets/     Genomic datasets
│   ├── methods/      Analytical methods
│   └── syntheses/    Cross-cutting reviews
└── archive/          Completed or inactive material
```

All files in `wiki/` and `areas/people/` carry YAML frontmatter. Templates enforce consistency. `AGENTS.md` at the vault root governs all agent behavior — naming conventions, linking rules, the inbox-first principle, and the decision flowchart for file routing.

## Memory Layers

The system maintains memory at multiple levels of abstraction, each optimized for different access patterns:

### Layer 1: The Vault (Structured Long-Term Knowledge)

The Obsidian vault is the canonical store of curated knowledge. Papers with structured frontmatter and cross-references. Collaborator profiles with interaction history. Meeting notes with action items. Grant tracking with budget periods and milestones. This is the knowledge that *has structure* — typed, linked, searchable by metadata.

Agents write to the vault when producing documents meant for human review: literature summaries, tool comparisons, meeting notes, grant sections. The vault is the shared output layer — anything worth reading later lives here.

### Layer 2: QMD (Semantic Search Across Everything)

QMD is the search layer — a hybrid BM25 + vector embedding + LLM reranking engine that indexes the entire vault, Apple Notes (864+ notes), session transcripts, group memories, research docs, and state files. When an agent needs to *find* something but doesn't know where it is, QMD is the first query.

QMD runs locally as an HTTP daemon (port 8181), accessed by agents via MCP. Collections are continuously re-indexed as content changes. Embeddings are generated locally via Ollama, keeping everything on-device.

In the optimal version, QMD evolves beyond document search into **entity-aware retrieval**. A query for "Rachel Smith BrainGO" doesn't just find documents containing those words — it traverses the entity graph to also surface: Rachel's collaborator profile, the BrainGO grant aims, the LDSC results Sep ran last month, and the meeting note from January where the project direction was decided.

### Layer 3: SimpleMem (Conversational Long-Term Memory)

SimpleMem is the *experiential* memory — facts extracted from conversations, compressed with coreference resolution and temporal anchoring. When an agent learns that "Mike prefers bullet points over paragraphs" or "the postdoc candidate from Yale is starting in September," these facts are stored in SimpleMem and retrievable by any agent across any session.

SimpleMem runs as a Docker container (port 8200), backed by LanceDB vectors on the Dropbox-synced vault (`marvin-vault/30-areas/simplemem-data/`). It uses local Ollama models for embedding and LLM processing. The memory database is shared between NanoClaw and Marvin — a joint memory pool that compounds across all interactions regardless of which system handled them.

In the optimal version, SimpleMem becomes more than a fact store. It maintains a **temporal model** of Mike's world: what was true last month vs. what's true now, how priorities have shifted, which relationships have strengthened or cooled. Agents can query not just "what do I know about X?" but "how has X changed over the last quarter?"

### Layer 4: Per-Group Working Memory

Each agent group (LAB-claw, SCIENCE-claw, HOME-claw) maintains its own `memory.md` and working files in its isolated filesystem. This is the *active context* — the team roster, current focus areas, active threads, and group-specific configuration. It's smaller and more focused than the vault, designed for fast loading at session start.

### Layer 5: The Knowledge Graph (Not Yet Built)

The missing layer. A continuously maintained graph of entities (people, papers, datasets, grants, meetings, decisions, conversations) and their typed relationships. Not a separate database — a lightweight SQLite index that cross-references entities across all other layers.

When you ask "what's the status of the XRN2 project?", the graph traverses: the grant → its aims → the people assigned to each aim → their recent commits and Slack messages → the datasets they're working with → the papers those datasets came from → known issues with those methods. It synthesizes a status that incorporates information you haven't even seen yet.

The graph is self-correcting. When it learns that a collaborator changed institutions, every reference updates. When a grant ends, related entities shift from active to archived. The graph maintains temporal versioning — what was true when, and what changed.

---

## Always-On Perception

Every information source streams into a unified perception layer in real-time. Not batched. Not polled. Understood immediately in the context of everything else.

### Email

Every message across all accounts (Penn Exchange, mgandal@gmail.com, mikejg1838@gmail.com, CHOP) is read the instant it arrives via push notifications (Gmail API webhooks, Exchange push subscriptions). Each email is understood not just by its content but by its full relational context: every prior conversation with that person, every project they're involved in, every deadline that's active, the social dynamics of the relationship, and the urgency implied by the sender's communication patterns.

Email processing inherits Marvin's triage system: 8 categories, 3 priority levels, draft-first policy for all outbound, and the rule that replies always come from the account that received the original. The triager knows that emails from NIH program officers, department chairs, and grant collaborators get elevated priority regardless of subject line. It knows that meeting confirmations and seminar announcements can be handled autonomously.

### Calendar

Not just "what's next" but continuous temporal reasoning. It knows that your 2pm was moved to 3pm, that this creates a conflict with the seminar you wanted to attend, that the person you were meeting is flying out tomorrow so rescheduling to next week won't work, and that there's a 45-minute window at 4:15 if you skip the optional committee meeting — and it knows which committee meetings you actually skip vs. which ones have political cost.

Calendar awareness spans all three source calendars (MJG, Outlook, Gandal_Lab_Meetings) accessed via EventKit, plus the family shared calendar (morgan.gandal@gmail.com). The scheduleSync deduplication logic ensures no double-counting across synced calendars.

### Slack

Every channel, every DM, every thread across the lab Slack workspace. It sees a student mentioning their pipeline is failing before you do, cross-references it with known issues in the analysis environment, and either answers directly (if authorized) or drafts you a message with the fix.

### Literature

Continuous monitoring of bioRxiv, medRxiv, PubMed, researcher feeds, and journal tables of contents. When a competing group posts a revision of a paper in your area, it reads the full text, diffs it against the previous version in the vault, identifies what's new, assesses relevance to active projects and grants, and surfaces it during your next natural break.

It also monitors methods papers, tool releases, and dataset announcements. The vault's `wiki/tools/` and `wiki/methods/` sections stay current not because someone manually updates them but because the system detects relevant changes in the field and proposes updates.

### Grants and Funding

Every deadline, every progress report due date, every budget period, every no-cost extension window. NIH RePORTER monitoring for competing and complementary awards. RFA tracking based on NIH strategic plan cycles and institute priorities. When a relevant RFA drops, the system has already drafted a preliminary concept note based on current projects and capabilities.

### Meeting Transcripts

After every meeting (via Granola integration, Otter, or Zoom transcription), the system processes the transcript with understanding of who spoke, which statements are action items vs. social pleasantries, which commitments are real, what decisions were made, and what was mentioned but not resolved. Action items become tasks assigned to the right agents. Decisions update project status. Unresolved items get added to future meeting agendas.

---

## The Agent Team

Five persistent agents with distinct roles, continuous memory, and autonomous communication with each other. They are always running, always aware, always working.

### Claire — Chief of Staff

The orchestrator. She synthesizes information from all sources, composes briefings, manages the other agents, and serves as the primary interface. She has the broadest context and the highest judgment requirements. She decides what rises to your attention and what gets handled silently.

Claire's unique capability is **prioritization under ambiguity**. When three things are urgent, she knows which one you'd want to handle first based on your patterns, the relative stakes, and the time sensitivity. She doesn't just rank by deadline — she models your actual decision-making.

Claire inherits Marvin's session flow: the morning briefing (`/marvin:digest`), the continuous checkpoint cycle, the end-of-session summary, and the heartbeat auto-save. But unlike Marvin, Claire doesn't wait for you to start a session — she's always on, composing and delivering information as events arrive.

### Jennifer — Executive Assistant

Handles the operational fabric of both professional and personal life. In LAB-claw: email triage, scheduling, travel, expenses, letters of recommendation (via michael.gandal@pennmedicine.upenn.edu and Outlook). In HOME-claw: personal errands, family coordination, personal calendar management (via mgandal@gmail.com and the MJG/family calendars).

Jennifer inherits Marvin's contact tracking system — every email interaction updates the relevant collaborator profile in the vault. She maintains the `areas/people/collaborators/` directory, keeping `last_contact`, `next_action`, and interaction history current for every person in Mike's network.

### Einstein — Research Scientist

Monitors the scientific landscape and produces research intelligence. Reads papers, tracks competitors, synthesizes literature, identifies opportunities, writes grant sections, maintains the vault's `wiki/` section.

Einstein's unique capability is **scientific synthesis** — placing new findings in the context of Mike's research program, not just summarizing them. He maintains living literature reviews that update as new papers are published. When writing grant sections, he constructs arguments, identifies gaps, and knows which reviewers care about which framing.

Einstein inherits Marvin's knowledge base processing pipeline (`/marvin:kb-process`) and the vault's structured paper/tool/dataset/method templates with full frontmatter.

### Sep — Data Scientist

The computational engine. Analyzes datasets, builds pipelines, tracks tools and methods, writes code. He maintains a complete inventory of every dataset the lab has access to: what's been analyzed, what hasn't, what analyses would be possible but haven't been attempted.

Sep knows the vault's `wiki/datasets/` and `wiki/tools/` sections intimately. When a new tool outperforms an existing one on benchmarks relevant to your data, Sep evaluates whether migrating is worth the effort — and if so, does it.

### Franklin — Lab Manager

Handles lab operations: purchasing, vendor coordination, equipment, space management, onboarding, compliance. He knows the lab's physical and administrative reality from the vault's `lab/` section.

Franklin inherits Marvin's expense report system (foreign travel CNAC-ORG-BC-FUND codes, CREF numbers) and the lab roster tracking.

### How They Coordinate

The agents communicate through a typed message bus, not through you. Each agent publishes findings, requests, and status updates tagged with topics. Other agents subscribe to topics they care about.

When Einstein finds a paper relevant to a grant, Jennifer sees the event and updates the citation database. When Franklin notices a supply shortage, Sep adjusts the analysis timeline. When Jennifer schedules a meeting with a collaborator, Claire assembles a prep brief that includes Einstein's latest analysis of that collaborator's recent work.

You see the outcomes in your Telegram groups. You don't direct the coordination. The agents figure out who needs to know what.

---

## Genuine Anticipation

### The Monday Morning Briefing

Before you've opened anything, the system has composed your week. Not a list of meetings — a narrative:

> This week's pressure point is the SFARI progress report (due Friday). You have drafts from the spatial team but nothing from the clinical arm. I'd suggest moving your Wednesday afternoon free block to writing time and sending a nudge to the clinical team today.
>
> The Flint seminar on Thursday overlaps with your CHOP meeting. The Flint talk will be recorded; the CHOP meeting won't. Flint is presenting work adjacent to the Cameron eQTL paper Einstein just added to the KB, so you'll want to watch the recording eventually.
>
> Three things need your decision today. Your 2-3 PM gap is still protected for the APA review.

### Meeting Intelligence

Before each meeting: a prep brief with relationship history, what changed since last time, what they might raise, what you should raise, and relevant deadlines. After each meeting: action items extracted from the transcript, assigned to the right agents, with follow-up reminders set.

### Sensing Drift

When a project hasn't had a commit in two weeks, when a collaborator hasn't responded to three emails, when a grant aim is falling behind its milestone timeline, when a student's Slack activity drops off — the system detects drift before it becomes a crisis.

"The spatial transcriptomics integration has stalled — last activity was March 4. This may be finals-related. Suggest a check-in at your next 1:1, which is... not scheduled. Want me to propose a time?"

### The Overcommitment Guard

> You agreed to three new collaborations this month. Your current commitments already exceed your available research hours by approximately 15%. The two lower-priority collaborations could be deferred 6-8 weeks without relationship cost. Want me to draft polite timeline emails?

This requires modeling actual capacity — not just calendar hours but productive hours. Clinical weeks cut research time in half. Grant deadline weeks consume everything. Monday mornings are protected focus time. The system knows all of this from observed patterns.

---

## Fluid Interaction Tiers

### Push Notifications

A morning summary on your phone. An urgent flag when something truly needs immediate attention. Most days, 3-5 notifications. Not 30. The system knows the difference between urgent-for-you and urgent-for-someone-else.

### Quick Exchanges

"What's the status of the Wamsley reanalysis?" gets a 30-second answer. "Draft a reply to Sarah's email" gets a draft in your inbox in under a minute. "Approve" and "send option B" trigger complex multi-step actions because the system already has the context. No session overhead, no context loading.

### Deep Sessions

When you need to think through a grant strategy, plan a paper, or do a deep research dive. The difference: all context is already loaded. You never start cold.

### Autonomous Execution

Scheduling meetings with known collaborators. Filing expense reports. Updating the lab website. Processing routine emails. Keeping the knowledge base current. Reordering supplies. You review a daily log of autonomous actions and veto anything wrong.

---

## Trust Calibration

Every combination of `(agent, action type, context)` maps to an autonomy level: **Autonomous**, **Notify**, **Draft**, or **Ask**.

The matrix starts conservative. Over time, as the system observes approval patterns, it proposes promotions:

> Jennifer's meeting confirmations have been approved 47/47 times. Suggest promoting to autonomous?

> You've been reviewing Jennifer's routine scheduling emails for 3 months and have never changed one. This review step costs you approximately 15 minutes per day.

Trust is context-sensitive. Jennifer can send routine emails autonomously to lab members, but the same quality email to a study section member stays in draft mode. The system models reputational risk — trust boundaries are tighter where the consequences of a mistake are larger.

---

## Research Partnership

### Living Literature Reviews

Continuously updated reviews for each research area. When writing a grant, the system constructs the argument, identifies gaps, and knows which reviewers care about which framing — because it's been tracking study section compositions and recent awards.

### Data Awareness

Sep maintains a complete dataset inventory. "You have the Velmeshev data and the Wamsley data on the CHOP cluster. No one has compared their astrocyte signatures. That analysis would directly support Aim 2 of the SFARI grant."

### Journal-Aware Writing

The system adapts style to the target journal. It knows that Molecular Psychiatry reviewers push back harder on methods than Nature Neuroscience reviewers. It knows your writing tics. This is learned from your publication history, reviewer feedback, and revision patterns.

### Grant Strategy

Which institutes fund your type of work, which study sections review it, who serves on those sections, what they've funded recently. When considering R01 vs. R21, or NIMH vs. NICHD, or which study section to request, the system has data-driven recommendations.

---

## Multi-Modal Awareness

A photo of a whiteboard → OCR, routing to relevant agents, filed in the project folder. A receipt from a conference dinner → expense report filed automatically. A voice memo → transcribed, routed by content (research idea to Einstein, errand to Jennifer). A forwarded PDF → indexed by PageIndex for hierarchical access, summary written to the vault.

---

## System Self-Awareness

### Anomaly Detection

A lightweight deterministic daemon monitors: container spawn rates, token usage, error rates, MCP endpoint health, message queue depth, session age distribution. Anomalies are caught in minutes, not days. Offending components are paused automatically with a clear notification.

### Graceful Degradation

When SimpleMem goes down, agents work with local memory. When Gmail auth expires, Jennifer queues drafts. When Ollama is slow, agents skip local model calls. No single failure brings down the system. Each degraded state is communicated clearly.

### Self-Improvement

The system runs its own retrospectives. What did it predict that was wrong? What did it miss? What did it surface that wasn't useful? These feed back into priority scoring, alert thresholds, and agent coordination — not through retraining but through calibration of attention, urgency, and trust parameters.

The self-improvement loop inherits Marvin's `tasks/lessons.md` pattern — every correction generates a rule that prevents the same mistake. But at scale, this becomes systematic: patterns across hundreds of interactions reveal calibration drift, coverage gaps, and emerging needs before they're reported.

---

## What Makes This Different

**It's event-driven, not request-response.** You don't ask it to check your email. Email arrives and is processed. You don't ask it to monitor preprints. New papers are read and assessed. The system is always working, not waiting.

**It's multi-agent with genuine coordination.** The agents have different tools, different memory, different trust levels, different autonomy boundaries, and they communicate with each other without you in the loop. Einstein's finding triggers Jennifer's action triggers Franklin's procurement, and you see the result, not the process.

**It learns from observation, not instruction.** Your approval patterns become trust boundaries. Your scheduling preferences become constraints. Your writing style becomes its voice. Your priority intuitions become its ranking model. Over months, the gap between what it does autonomously and what you would have done narrows toward zero for routine decisions.

**It's built on local infrastructure, synced via Dropbox.** The vault, the memory systems, the agent processes — all local. Dropbox provides cross-machine sync. The only external dependency is the LLM API. Everything else is yours.

---

## The Gap

The technology exists. The models are smart enough. The building blocks — containers, IPC, memory systems, MCP integrations, structured vaults — are already in place across Marvin, NanoClaw, and OpenClaw.

The gap is in three places:

**Persistent agent orchestration.** Keeping five LLM agents running continuously with stable memory, crash recovery, and graceful context management. The SDK supports session resume and compaction. The engineering to keep agents alive for days and weeks — not minutes — needs to be built from the patterns already proven in NanoClaw's container system and OpenClaw's subagent framework.

**Judgment under ambiguity.** The hardest decisions aren't "what to do" but "whether to do anything at all." Knowing that a cold email thread means they're busy (wait) vs. losing interest (follow up now) vs. didn't see it (resend). Current models can approximate this. The trust calibration system handles the consequences of getting it wrong. But the aspiration is genuine situational judgment that improves with every observed outcome.

**Coherent identity across time.** A human chief of staff who's been with you for 10 years has a continuous identity — they remember not just facts but the *feeling* of past interactions, the evolution of relationships, the way priorities shifted over seasons. Current agents have session-bounded identity stitched together with memory systems. The optimal version has something closer to genuine continuity — not consciousness, but a consistent perspective that deepens over months and years rather than resetting every few hours. The five-layer memory architecture (vault, QMD, SimpleMem, working memory, knowledge graph) is the foundation for this continuity. What remains is making the stitching seamless enough that no session boundary is perceptible.

The system described here will exist. The pieces are being built right now — in this repository and across the industry. The question is assembly.
