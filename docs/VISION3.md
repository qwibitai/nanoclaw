# The Optimal Executive AI

## What It Is

An ambient intelligence that wraps around your entire professional and personal life. It never sleeps, never polls, never waits for you to open a terminal. It perceives everything happening across your digital surfaces in real-time, maintains a deep structured understanding of your world, acts autonomously within calibrated trust boundaries, coordinates a team of specialized agents without you as the router, and learns from every interaction to get better every day.

It is not a chatbot. It is not an assistant you summon. It is an extension of your executive function — the part of your brain that tracks, prioritizes, remembers, follows up, connects dots, and catches things before they fall. You focus on what only you can do: the scientific thinking, the mentoring, the clinical judgment, the creative leaps. Everything else just happens.

---

## Lineage

This system is the convergence of three existing implementations, each contributing a critical layer:

**Marvin** (`~/Agents/marvin2`) is the spiritual ancestor — the original AI Chief of Staff. It contributes: the session-based workflow (`/marvin`, `/marvin:end`, `/marvin:update`), the daily digest pipeline (`/marvin:digest`), the email triage system (8 categories, 3 priority levels, Mac Mail AppleScript + Gmail API), the heartbeat auto-save pattern, the contact tracking framework (`content/collaborators/`), the self-improvement loop (`tasks/lessons.md`), the custom subagent architecture (NIH Reporter, dossier agent, deadline monitor, email triager, kb-search), the Granola meeting transcript integration, the promotion dossier workflow, and the deep Obsidian vault conventions with YAML frontmatter, templates, and `AGENTS.md` governance. Marvin understands the *content* of Mike's professional life better than anything else.

**NanoClaw** (`~/Agents/nanoclaw`) contributes the runtime architecture — the part that makes agents always-on rather than summoned. It provides: container isolation (Apple Container Linux VMs), the credential proxy (secrets never enter containers), the Telegram channel system with agent swarm (pool bots for subagent identities), the IPC message bus (tasks, messages, inter-group communication), the session management system (resume, expiry, compaction), the scheduled task framework (cron with three-layer validation), the MCP server integration layer (QMD, SimpleMem, Apple Notes, Todoist, Ollama, Gmail, bioRxiv, PubMed, Open Targets, Clinical Trials), the mount security allowlist, and the group-based isolation model where each team has its own filesystem, memory, and session.

**OpenClaw** (`~/Agents/openclaw` and `~/.openclaw`) contributes the agent platform layer — the infrastructure for running persistent agents at scale. It provides: the sandbox execution model, the subagent orchestration framework, the identity and authentication system, the delivery queue for reliable message routing, the cron subsystem, the canvas/workspace abstraction, the device management layer, and the extension architecture for adding channels and capabilities as plugins. OpenClaw understands how to run agents as *services* rather than as CLI sessions.

The optimal system takes all three and merges them into something none of them can be alone.

---

## Where It Runs

Locally on a Mac. Not in the cloud. The host machine is the orchestrator, the credential vault, the connection point to macOS-native services (Calendar via EventKit, Mail via AppleScript, Apple Notes, iCalBuddy), and the bridge to containerized agents. Local execution means: low latency for real-time perception, direct access to macOS APIs without cloud proxying, full control over data residency, and no dependency on external infrastructure beyond the LLM API itself.

The primary interface is **Telegram** — groups for each domain (LAB-claw, SCIENCE-claw, HOME-claw, CODE-claw), with the main DM for direct communication. Telegram provides: cross-device access (phone, desktop, tablet), push notifications with per-group control, bot identities for subagents via the swarm pool, media support (photos, voice memos, documents), and low-friction interaction from anywhere.

Deep interactive sessions happen via **MARVIN** (Claude Code on the terminal) for complex multi-step work — grant writing, paper analysis, pipeline debugging, strategic planning. MARVIN and NanoClaw are complementary interfaces: MARVIN is the deep-session tool with full reasoning and file editing; NanoClaw is the always-on layer with event-driven push. They share the vault, the state files, the knowledge base, and the contact database. What NanoClaw's agents discover enriches MARVIN's context. What you build in MARVIN sessions feeds back into NanoClaw's knowledge.

---

## Two-Tier Intelligence

The system operates under a hard constraint: **no hosted API calls for background work.** Every token of Claude reasoning is precious — used for judgment, synthesis, and creativity. Everything else runs locally at zero marginal cost.

### Tier 1: Local Models (Always Running, Zero Cost)

Small local models (via Ollama — Llama 3.1 8B, Phi-3, Mistral 7B, glm-4.7-flash, qwen3) handle the continuous background work that constitutes 80% of system activity:

- **Classification**: Is this email urgent / routine / ignorable? Is this Slack message for me or just noise?
- **Entity extraction**: Who / what / when from emails, transcripts, paper abstracts
- **Routing**: Which agent domain does this belong to? Does it need Claude or can Ollama handle it?
- **Simple drafting**: Meeting confirmations, acknowledgments, routine scheduling responses
- **Memory tagging**: Classifying and indexing new information into the knowledge graph
- **Event detection**: Did something change that matters? New email, calendar update, file change, Slack mention
- **Summarization**: Condensing low-stakes content into structured JSON for upstream consumption
- **Embedding**: Vector embeddings for QMD and SimpleMem (already running via qwen3-embedding)

These run continuously. They consume local GPU/CPU but zero API tokens. They're wrong sometimes — and that's fine, because they're triaging and extracting, not deciding. Everything above their confidence threshold gets queued for Claude.

### Tier 2: Claude (Invoked When Needed, Token-Conscious)

Claude handles everything that requires genuine reasoning:

- Nuanced judgment (the NIH program officer response, the tenure committee email)
- Complex synthesis (the Monday briefing, cross-project status reports)
- Multi-step reasoning (grant strategy, paper analysis, debugging a student's stalled project)
- Creative work (drafting emails in your voice, writing grant sections, composing meeting briefs)
- Cross-domain connection (linking a new paper to three grants and a student's project)
- Social calibration (knowing that "I'll circle back" from a program officer means something different than from a grad student)

Claude sessions don't have to be interactive. NanoClaw already spawns headless agent containers from scheduled tasks. The morning briefing, the paper review queue, the email draft batch — these all run as scheduled Claude sessions with pre-assembled context, writing outputs to the IPC bus. You see results in Telegram, not in a terminal.

### The Handoff

The boundary between tiers is the system's most important optimization surface. Ollama processes raw events into structured data — JSON with confidence scores, entity tags, urgency ratings. Claude never reads raw emails or raw paper abstracts for routine work. It reads Ollama's structured output and makes decisions on pre-digested information.

```
Raw event (email arrives)
  → Ollama: classify, extract, route → structured JSON
    → Below confidence threshold? → Queue for Claude
    → Above threshold + routine? → Handle autonomously
    → Above threshold + needs judgment? → Queue for next Claude batch
```

This means a Claude session processing 7 queued items costs the same as processing 1, because the context assembly is done by deterministic scripts reading Ollama's structured outputs.

### Token Conservation

The system is engineered to maximize intelligence per token:

- **Ollama does 80% of the volume.** Most events are routine. Classification, calendar parsing, entity extraction, simple responses — all zero token cost. The ratio of Ollama-processed to Claude-processed events should be at least 4:1.
- **Precomputed context, not retrieval.** Instead of Claude reading 50 files each session, deterministic scripts assemble a context packet: today's schedule, pending items from each agent queue, recent state changes, relevant memories. Claude gets a dense, pre-assembled briefing — not raw files to wade through.
- **Batch, don't stream.** Instead of invoking Claude for each email, batch all pending items into one session. "Here are 7 items that need your judgment" is far cheaper than 7 separate invocations. The scheduler's natural cadence (morning briefing, midday check, evening digest) creates natural batch windows.
- **Structured outputs from Ollama.** Ollama extracts structured data (JSON) that Claude can consume without re-parsing. When Einstein's Ollama tier reads a paper abstract, it outputs `{"relevance": "high", "domains": ["spatial-transcriptomics", "asd"], "related_grants": ["SFARI"], "summary": "..."}`. Claude doesn't re-read the abstract — it reads the structured output and makes a judgment call.
- **Incremental context.** Each Claude session starts with a compact state summary, not the full history. The vault is the source of truth; Claude reads only what's changed since the last session.

---

## The Knowledge Base

The core knowledge base is an **Obsidian-compatible vault** at `/Volumes/sandisk4TB/Dropbox/AGENTS/marvin-vault/`. Dropbox syncs it across machines. Obsidian provides the human interface for browsing, editing, and graph visualization. Agents read and write to it directly.

```
marvin-vault/
├── inbox/            Unsorted captures (triage queue)
├── daily/            Time-stamped notes
│   ├── journal/      Daily session summaries (YYYY-MM-DD.md)
│   ├── meetings/     Meeting notes (with 1v1/ for recurring)
│   └── talks/        Seminar and conference notes
├── projects/         Active research projects and grants
│   ├── active/
│   └── grants/
├── areas/            Ongoing responsibilities
│   └── people/
│       ├── collaborators/  External collaborator profiles
│       └── lab/            Lab member profiles
├── lab/              Lab operations (admin, protocols, letters)
├── resources/        Reference material
│   ├── bookmarks/    Saved web pages
│   ├── paperpile/    Paperpile exports, .bib files
│   ├── twitter/      Saved tweets and threads
│   ├── email-digests/  Weekly email digest summaries
│   └── media/        Images, PDFs, attachments
├── wiki/             Curated research knowledge base
│   ├── papers/       Structured paper entries (kb-paper)
│   ├── tools/        Bioinformatics tools (kb-tool)
│   ├── datasets/     Genomic datasets (kb-dataset)
│   ├── methods/      Analytical methods (kb-method)
│   └── syntheses/    Cross-cutting review notes
└── archive/          Completed or inactive material
```

All files in `wiki/` and `areas/people/` carry YAML frontmatter with typed fields (type, status, added, last_updated). Templates enforce consistency. `AGENTS.md` at the vault root governs all agent behavior — naming conventions, wikilink conventions, the inbox-first principle, and the decision flowchart for file routing. Every agent that reads or writes to this vault must follow `AGENTS.md`.

---

## Memory Architecture

The system maintains memory at five levels of abstraction, each optimized for different access patterns. Together they create the illusion of continuous, coherent memory across sessions, agents, and time.

### Layer 1: The Vault (Structured Long-Term Knowledge)

The Obsidian vault is the canonical store of curated knowledge. Papers with structured frontmatter and cross-references. Collaborator profiles with interaction history and `last_contact` / `next_action` fields. Meeting notes with action items. Grant tracking with budget periods and milestones. This is the knowledge that *has structure* — typed, linked, searchable by metadata.

Agents write to the vault when producing documents meant for human review or long-term reference. The vault is the shared output layer — anything worth reading later lives here, filed according to `AGENTS.md` conventions.

### Layer 2: QMD (Semantic Search Across Everything)

QMD is the search layer — a hybrid BM25 + vector embedding + LLM reranking engine that indexes the entire vault (800+ documents), Apple Notes (864+ notes), session transcripts, group memories, research docs, state files, and conversation archives. When an agent needs to *find* something but doesn't know where it is, QMD is the first query.

QMD runs locally as an HTTP daemon (port 8181), accessed by agents via MCP. Collections are continuously re-indexed as content changes. Embeddings are generated locally via Ollama (qwen3-embedding), keeping everything on-device.

In the optimal version, QMD evolves beyond document search into **entity-aware retrieval**. A query for "Rachel Smith BrainGO" doesn't just find documents containing those words — it traverses the entity graph to also surface: Rachel's collaborator profile, the BrainGO grant aims, the LDSC results Sep ran last month, and the meeting note from January where the project direction was decided.

### Layer 3: SimpleMem (Conversational Long-Term Memory)

SimpleMem is the *experiential* memory — facts extracted from conversations, compressed with coreference resolution and temporal anchoring. When an agent learns that "Mike prefers bullet points over paragraphs" or "the postdoc candidate from Yale is starting in September," these facts are stored in SimpleMem and retrievable by any agent across any session.

SimpleMem runs as a Docker container (port 8200), backed by LanceDB vectors on the Dropbox-synced vault (`marvin-vault/areas/simplemem-data/`). It uses local Ollama models for embedding and LLM processing. The memory database is shared between NanoClaw and Marvin — a joint memory pool that compounds across all interactions regardless of which system handled them.

In the optimal version, SimpleMem becomes more than a fact store. It maintains a **temporal model** of the world: what was true last month vs. what's true now, how priorities have shifted, which relationships have strengthened or cooled. Agents can query not just "what do I know about X?" but "how has X changed over the last quarter?"

### Layer 4: Per-Group Working Memory

Each agent group (LAB-claw, SCIENCE-claw, HOME-claw) maintains its own `memory.md` and working files in its isolated filesystem. This is the *active context* — the team roster, current focus areas, active threads, and group-specific configuration. It's smaller and more focused than the vault, designed for fast loading at session start.

### Layer 5: The Knowledge Graph

The capstone layer. A continuously maintained graph of entities (people, papers, datasets, grants, meetings, decisions, conversations) and their typed relationships. Not a separate database — a lightweight SQLite index that cross-references entities across all other layers, maintained by Ollama's entity extraction running against every new piece of information.

When you ask "what's the status of the XRN2 project?", the graph traverses: the grant → its aims → the people assigned to each aim → their recent commits and Slack messages → the datasets they're working with → the papers those datasets came from → known issues with those methods. It synthesizes a status that incorporates information you haven't even seen yet.

The graph is self-correcting. When it learns that a collaborator changed institutions, every reference updates. When a grant ends, related entities shift from active to archived. The graph maintains temporal versioning — what was true when, and what changed.

---

## Always-On Perception

Every information source streams into a unified perception layer. Not batched hourly. Event-driven: the moment something changes, it's detected, classified by Ollama, and routed.

### Email

Every message across all accounts (Penn Exchange, mgandal@gmail.com, mikejg1838@gmail.com, CHOP) is read the instant it arrives via push notifications (Gmail API webhooks, Exchange push subscriptions, IMAP IDLE). Each email is understood not just by its content but by its full relational context: every prior conversation with that person, every project they're involved in, every deadline that's active, the social dynamics of the relationship, and the urgency implied by the sender's communication patterns.

Ollama handles the initial classification — sender importance, topic extraction, urgency rating, suggested routing. Only emails that require judgment, drafting, or complex responses escalate to Claude. Meeting confirmations and seminar announcements are handled autonomously.

Email processing inherits Marvin's triage system: 8 categories, 3 priority levels, draft-first policy for all outbound, and the rule that replies always come from the account that received the original.

### Calendar

Not just "what's next" but continuous temporal reasoning. It knows that your 2pm was moved to 3pm, that this creates a conflict with the seminar you wanted to attend, that the person you were meeting is flying out tomorrow so rescheduling to next week won't work, and that there's a 45-minute window at 4:15 if you skip the optional committee meeting — and it knows which committee meetings you actually skip vs. which ones have political cost.

Calendar awareness spans all source calendars (MJG, Outlook, Gandal_Lab_Meetings) accessed via EventKit, plus the family shared calendar (morgan.gandal@gmail.com). The scheduleSync deduplication logic ensures no double-counting across synced calendars. Calendar changes propagate instantly — when a meeting moves, every downstream dependency is re-evaluated: prep time, travel buffers, deep work blocks, the relative priority of what's being displaced.

### Slack and Messaging

Every channel, every DM, every thread across the lab Slack workspace. It sees a student mentioning their pipeline is failing before you do, cross-references it with known issues in the analysis environment, and either answers directly (if authorized) or drafts you a message with the fix. It distinguishes signal from noise — most Slack messages don't need your attention.

### Literature

Continuous monitoring of bioRxiv, medRxiv, PubMed, researcher feeds on Twitter/Bluesky, and journal tables of contents. When a competing group posts a revision of a paper in your area, it reads the full text, diffs it against the previous version in the vault, identifies what's new, assesses relevance to active projects and grants, and surfaces it during your next natural break.

Ollama handles the first pass — abstract classification, relevance scoring, keyword extraction. Only papers scoring above the relevance threshold get full-text analysis by Claude. Monitoring 50 overnight preprints costs minutes of Ollama time and zero Claude tokens for the 45 that aren't relevant.

It also monitors methods papers, tool releases, and dataset announcements. The vault's `wiki/tools/` and `wiki/methods/` sections stay current not because someone manually updates them but because the system detects relevant changes in the field and proposes updates.

### Grants and Funding

Every deadline, every progress report due date, every budget period, every no-cost extension window. NIH RePORTER monitoring for competing and complementary awards. RFA tracking based on NIH strategic plan cycles and institute priorities. When a relevant RFA drops, the system has already drafted a preliminary concept note based on current projects and capabilities.

### Meeting Transcripts

After every meeting (via Granola, Otter, or Zoom transcription), the system processes the transcript with understanding of who spoke, which statements are action items vs. social pleasantries, which commitments are real, what decisions were made, and what was mentioned but not resolved. Action items become tasks assigned to the right agents. Decisions update project status. If someone mentioned a paper or dataset, it's already been looked up.

---

## The Agent Team

Five specialized agents with distinct roles, domain expertise, and autonomous communication with each other. They run in isolated containers with persistent session state — containers that spin up on events and resume their prior context, with Ollama handling continuous background processing between Claude invocations.

### Claire — Chief of Staff

The orchestrator. She synthesizes information from all sources, composes briefings, manages the other agents, and serves as the primary interface. She has the broadest context and the highest judgment requirements. She decides what rises to your attention and what gets handled silently.

Claire's unique capability is **prioritization under ambiguity**. When three things are urgent, she knows which one you'd want to handle first based on your patterns, the relative stakes, and the time sensitivity. She doesn't just rank by deadline — she models your actual decision-making: "Mike will want to deal with the student crisis before the grant review because he always prioritizes people, even when the grant deadline is closer."

Claire is also the **editor**. She doesn't just aggregate outputs from other agents — she composes them into a single coherent briefing, deciding what level of detail each item needs, what order to present them in, and what to leave out entirely.

Claire inherits Marvin's session flow: the morning briefing, the continuous checkpoint cycle, the end-of-session summary, and the heartbeat auto-save. But unlike Marvin, Claire doesn't wait for you to start a session — she's always on, composing and delivering information as events arrive.

### Jennifer — Executive Assistant

Handles the operational fabric of both professional and personal life. In LAB-claw: email triage, scheduling, travel, expenses, letters of recommendation (via michael.gandal@pennmedicine.upenn.edu and Outlook). In HOME-claw: personal errands, family coordination, personal calendar management (via mgandal@gmail.com and the MJG/family calendars). She manages two personas and never mixes them.

Jennifer's unique capability is **social calibration**. She knows that emails to the department chair require a different tone than emails to a postdoc. She knows that "I'll circle back next week" from a program officer means something different than from a grad student. She drafts correspondence that sounds like you — not generic, not overly formal, but in your actual voice, adjusted for the recipient and context.

Jennifer inherits Marvin's contact tracking system — every email interaction updates the relevant collaborator profile in `areas/people/collaborators/`, keeping `last_contact`, `next_action`, and interaction history current for every person in the network. She also inherits the expense report system (CNAC-ORG-BC-FUND codes, CREF numbers).

### Einstein — Research Scientist

Monitors the scientific landscape and produces research intelligence. Reads papers, tracks competitors, synthesizes literature, identifies opportunities, writes grant sections, and maintains the vault's `wiki/` section. His domain is the science itself — the ideas, the methods, the data, the field.

Einstein's unique capability is **scientific synthesis**. He doesn't just summarize papers — he places them in the context of your research program. "This paper challenges Assumption 3 in your R01 Aim 2, but their sample size is small (N=47) and they used an older reference panel. Worth monitoring but not worth pivoting for yet." He thinks about your science the way a senior collaborator would.

Einstein inherits Marvin's knowledge base processing pipeline and the vault's structured paper/tool/dataset/method templates with full frontmatter. He maintains living literature reviews that update as new papers are published.

### Sep — Data Scientist

The computational engine. Analyzes datasets, builds pipelines, tracks tools and methods, writes code, monitors the lab's computational infrastructure. He knows every dataset the lab has access to, what's been analyzed, what hasn't, and what analyses would be possible but haven't been attempted.

Sep's unique capability is **proactive analysis**. "You have the Velmeshev data and the Wamsley data on the CHOP cluster. No one has compared their astrocyte signatures using the same pipeline. That analysis would directly support Aim 2 of the SFARI grant and would take approximately 4 hours of compute time." He doesn't wait to be asked — he identifies analytical opportunities and proposes them.

### Franklin — Lab Manager

Handles lab operations: purchasing, vendor coordination, equipment maintenance, space management, onboarding, compliance, safety training schedules, animal protocol renewals. He knows the lab's physical and administrative reality from the vault's `lab/` section.

Franklin's unique capability is **operational foresight**. He tracks inventory consumption rates and reorders before things run out. He knows that new students starting in September need accounts provisioned in August. He remembers that the last time the sequencer was serviced was 6 months ago and the manufacturer recommends annual maintenance. He handles the hundred small things that, if dropped, would slow the lab down.

### How They Coordinate

The agents communicate through a typed, filesystem-based message bus — not through you. No Redis, no RabbitMQ. Just the filesystem, which is debuggable (`ls` tells you the system state), survives reboots, and costs zero tokens.

```
data/bus/
├── inbox/              New events, timestamped JSON
├── processing/         Claimed by an agent (moved atomically)
├── done/               Completed (retained 72h for undo)
├── topics/
│   ├── email/          Symlinks to messages tagged with this topic
│   ├── research/
│   ├── scheduling/
│   ├── lab-ops/
│   └── personal/
└── agents/
    ├── einstein/
    │   ├── queue.json  Items waiting for this agent
    │   └── output.json Recent outputs for Claire to synthesize
    ├── jennifer/
    ├── franklin/
    ├── claire/
    └── sep/
```

Each agent publishes findings, requests, and status updates tagged with topics. Other agents subscribe to topics they care about. When Einstein finds a paper relevant to a grant, Jennifer sees the event and updates the citation database. When Franklin notices a supply shortage, Sep adjusts the analysis timeline. When Jennifer schedules a meeting with a collaborator, Claire assembles a prep brief that includes Einstein's latest analysis of that collaborator's recent work.

You see the outcomes in your Telegram groups. You don't direct the coordination. The agents figure out who needs to know what.

---

## A Day in the Life

Monday morning, 6:47 AM. You haven't opened your phone yet. The system has already been working for two hours.

At 4:30 AM, Einstein's scheduled task processed 11 new bioRxiv preprints posted overnight. Ollama classified them — 6 irrelevant, 3 low-relevance (filed), 2 high-relevance. A Claude session spun up for the two that mattered. One is from the Geschwind lab — a spatial transcriptomics analysis of human fetal cortex using the same MERFISH platform your lab just acquired. Einstein read the full text, compared their analytical approach to Sep's current pipeline, identified three methodological differences that matter, and wrote a two-page technical comparison to the vault. He flagged it for your attention but didn't wake you.

At 5:15 AM, Jennifer's email watcher detected three overnight emails. Ollama classified them — two routine, one high-priority. The routine ones (meeting confirmation, seminar announcement) were handled by Ollama directly: confirmed the meeting, added the seminar to your calendar with a note about a conflict. The third email is from an NIH program officer responding to your R01 resubmission inquiry. A Claude session spun up for Jennifer — she drafted three possible response strategies (ranging from cautious to assertive) and queued it for your morning briefing.

At 6:00 AM, Franklin's scheduled inventory check ran. Ollama scanned the procurement records — RNA extraction kits are running low and there's a bulk discount expiring Wednesday. Franklin prepared a purchase order but held it because it's over the auto-approve threshold. He also noticed that a rotation student's end date is Friday and no exit meeting is scheduled.

At 6:30 AM, Claire's morning briefing task fired. She read the output files from Einstein, Jennifer, and Franklin. She knows your calendar today: clinic from 9-11, then meetings at 11:30, 1:00, and 3:00, with a gap from 2-3 that she's been protecting all week because the APA review is overdue. She knows your energy patterns — you do your best writing before 11 AM, but Mondays you're in clinic. She composed the briefing.

Your phone buzzes once at 6:47 AM. One Telegram message from Claire. Not five agents talking over each other — one composed message that reads like a note from a human chief of staff who has been in the office since dawn:

> Monday March 23. Clinic this morning, 3 meetings after.
>
> *Needs your decision:*
> • NIH program officer replied about the R01 resubmission. Jennifer has 3 draft responses ready — the short version is they're open to a revision if you address Reviewer 2's power analysis concern. I'd suggest the middle option (firm but collaborative). Say "send option B" or "show me all three."
> • Franklin needs approval for RNA extraction kits ($2,400, bulk discount expires Wednesday). Say "approve" or "hold."
>
> *FYI:*
> • Geschwind lab posted a fetal cortex MERFISH paper overnight. Einstein wrote a comparison — it's in the vault. Three things they did differently that matter for our pipeline. Sep is already reviewing.
> • Rishi's rotation ends Friday. No exit meeting scheduled. Want me to handle it?
>
> Your 2-3 PM gap is still protected for the APA review.

You reply "send option B, approve, yes handle Rishi" while brushing your teeth. Eleven words. That triggers:

- Jennifer finalizes response option B, sends it from your pennmedicine.upenn.edu account (she has earned auto-trust for NIH correspondence you've pre-approved)
- Franklin submits the purchase order
- Claire schedules a 30-minute exit meeting with Rishi on Thursday, sends him a warm note about his rotation contribution

By the time you walk into clinic at 9 AM, all three are done.

At 10:15 AM during clinic, your phone buzzes. Claire knows you're in clinic so she only interrupts for things that meet the interruption threshold:

> Quick one — Cooper's thesis committee meeting just got moved to tomorrow 2 PM. That was your APA review block. I moved the review to Wednesday's 3-4 PM gap. If that doesn't work, reply with a better time.

You don't reply. Silence is consent for scheduling changes below a certain priority level. Claire logs it and moves on.

At 11:45 AM between meetings, you forward a photo of a whiteboard from a collaborator's office. No caption. Ollama's vision model OCRs the content, recognizes it as a study design diagram, routes it to Einstein and Jennifer. Einstein identifies connections to the SPARK consortium. Jennifer notices a mentioned "budget call Thursday" and adds prep to your calendar. You get no message about this. It'll surface in tomorrow's briefing if relevant.

At 2:00 PM, Einstein finishes the Geschwind MERFISH paper analysis. He posts to the bus:

```json
{
  "topic": "spatial-transcriptomics",
  "from": "einstein",
  "finding": "Hierarchical clustering outperforms our Leiden-based method on sparse data",
  "action_needed": "sep",
  "priority": "medium"
}
```

Sep's next run picks this up, evaluates the method on your pilot data, and posts back: 15% improvement, 3-hour runtime cost, recommends adoption. At 5 PM, Claire's daily digest synthesizes it:

> Einstein and Sep evaluated a new clustering method from the Geschwind lab's MERFISH paper. 15% improvement for deep cortical layers, 3-hour runtime cost. Sep recommends adopting it. Comparison report in the vault. Want to discuss or approve the pipeline change?

You say "approve, nice work." Sep updates the pipeline. Einstein adds the paper to the vault with cross-references. Done.

---

## Genuine Anticipation

The difference between reactive and proactive is the difference between a secretary and a chief of staff.

### The Monday Morning Briefing

Not a list of meetings — a narrative of the week:

> This week's pressure point is the SFARI progress report (due Friday). You have drafts from the spatial team but nothing from the clinical arm. I'd suggest moving your Wednesday afternoon free block to writing time and sending a nudge to the clinical team today.
>
> The Flint seminar on Thursday overlaps with your CHOP meeting. The Flint talk will be recorded; the CHOP meeting won't. Flint is presenting work adjacent to the Cameron eQTL paper Einstein just added to the KB, so you'll want to watch the recording eventually.
>
> Your protected deep-work blocks are Tuesday 1-3pm and Thursday 9-11am. Deep-work queue: APA review (90 min), two paper reviews (45 min each), SFARI intro (60 min). That's 4 hours of work for 4 hours of blocks — tight but possible if nothing else comes in.

### Meeting Intelligence

Before each meeting: a prep brief — not a calendar entry, but actual context. Who you're meeting, your relationship history, what you last discussed, what's changed since then, what they might raise (inferred from their recent emails, papers, Slack activity), what you should raise, relevant deadlines. A suggested opening if it's been a while.

After each meeting: the system processes the Granola transcript. It extracts action items — but not naively. It knows which "I'll send that over" promises are real commitments vs. social pleasantries. Real ones become tasks assigned to the right agents. Decisions update project status. If someone mentioned a paper, it's already been looked up.

### Sensing Drift

When a project hasn't had a commit in two weeks, when a collaborator hasn't responded to three emails, when a grant aim is falling behind its milestone timeline, when a student's Slack activity drops off:

"The spatial transcriptomics integration has stalled — last activity was March 4. This may be finals-related (spring semester ends April 28). Suggest a check-in at your next 1:1, which is... not scheduled. Want me to propose a time?"

### The Overcommitment Guard

> You agreed to three new collaborations this month. Your current commitments already exceed your available research hours by ~15%, based on your calendar, active grants, and writing obligations. The two lower-priority collaborations could be deferred 6-8 weeks without relationship cost. Want me to draft polite timeline emails?

This requires modeling actual capacity — not just calendar hours but productive hours. Clinical weeks cut research time in half. Grant deadline weeks consume everything. Monday mornings are protected focus time. You chronically underestimate how long paper reviews take. The system knows all of this.

---

## Fluid Interaction Tiers

### Push Notifications (Telegram)

The lightest touch. A morning summary. An urgent flag. A "3pm cancelled" ping. Ruthlessly filtered — 3-5 per day, not 30. The system knows urgent-for-you vs. urgent-for-someone-else.

### Quick Exchanges (Telegram)

"What's the status of the Wamsley reanalysis?" → 30-second answer. "Draft a reply to Sarah's email" → draft in under a minute. "Approve" → complex multi-step action because the system already has context.

### Deep Sessions (MARVIN / Claude Code)

Grant strategy, paper writing, pipeline debugging, research deep dives. All context pre-loaded — you never start cold. The first message can be "let's work on the SFARI progress report" and everything is already assembled: aims, timeline, drafts, status, new results, program officer feedback.

### Autonomous Execution

Scheduling meetings. Filing expenses. Processing routine emails. Updating the knowledge base. Reordering supplies. Tracking deadlines. You review a daily log and veto anything wrong. Boundaries self-adjust based on approval patterns.

---

## Trust Calibration

Every combination of `(agent, action type, context)` maps to an autonomy level:

- **Autonomous**: Do it, log it, daily digest. Jennifer confirming meetings. Franklin ordering supplies < $200. Einstein saving paper summaries.
- **Notify**: Do it, tell me now. Jennifer rescheduling. Einstein flagging a competitor preprint. Calendar changes during clinic.
- **Draft**: Prepare it, wait for approval. Emails to external people. Grant sections. Communications outside immediate circle.
- **Ask**: Don't even prepare — ask first. Money > $500. Personnel decisions. Institutional leadership. Commitments > 3 months.

### Learned, Not Configured

The matrix starts conservative. Over time, it proposes promotions based on observed approval patterns:

> Jennifer's meeting confirmations: approved 47/47 times. Suggest promoting to autonomous?

> You've been reviewing Jennifer's scheduling emails for 3 months, never changed one. This review costs ~15 min/day.

Trust is context-sensitive. The same email type gets different trust levels depending on recipient (lab member vs. study section member). The system models reputational risk — boundaries are tighter where mistakes cost more.

---

## Research Partnership

Beyond administration, the system is a genuine intellectual collaborator.

### Living Literature Reviews

Continuously updated reviews for each research area. When writing a grant, the system constructs the argument, identifies gaps, knows which reviewers care about which framing — because it's been tracking study section compositions and recent awards. Reviews update automatically as new papers are published.

### Data Awareness

Sep maintains a complete dataset inventory. "You have the Velmeshev data and the Wamsley data on the CHOP cluster. No one has compared their astrocyte signatures. That analysis would directly support Aim 2." "The new BrainSpan release includes temporal cortex samples you've been waiting for. Download will take 6 hours. Want me to start it tonight?"

### Methods Intelligence

When a new method outperforms scVI on your benchmarks, Sep evaluates migration cost. When Seurat releases a breaking change, it's flagged before anyone hits the error. "Geschwind's group switched from Seurat to Scanpy. Their clustering outperforms yours by ~15% on sparse data. Sep has already evaluated on your pilot dataset."

### Grant Strategy

Which institutes fund your work, which study sections review it, who serves on those sections, what they've funded recently, what their priorities are. R01 vs. R21, NIMH vs. NICHD, which study section to request — data-driven recommendations based on success rates and competitive landscape.

### Journal-Aware Writing

Style adapts to target journal. Molecular Psychiatry reviewers push back harder on methods than Nature Neuroscience. Cell Genomics expects extensive supplementary descriptions. The system knows your writing tics. Learned from your publication history, reviewer comments, and revision patterns.

---

## Multi-Modal Awareness

- **Photo of whiteboard** → Ollama vision OCR → route to relevant agents → file in project folder
- **Receipt photo** → Franklin processes expense: vendor, amount, grant to charge, reimbursement filed
- **Voice memo** → local Whisper transcription → Ollama classifies → route by content (research idea → Einstein, errand → Jennifer)
- **Meeting transcript** → Granola → action items extracted, decisions logged, unresolved items queued, papers/datasets mentioned already looked up
- **Forwarded PDF** → PageIndex hierarchical indexing → summary to vault → full text searchable via QMD

---

## System Self-Awareness

### Anomaly Detection

A lightweight deterministic daemon (not an LLM) continuously watches: container spawn rates (runaway tasks), token usage estimates (cost anomalies), error rates by agent (degraded performance), MCP endpoint health (infrastructure failures), message queue depth (bottlenecks), Ollama response times (local inference degradation), memory system coherence (stale/conflicting information).

When any metric exceeds its threshold: pause the offending component, notify via dedicated "System" Telegram channel, log detailed incident report. The cron-every-3-minutes incident would be caught in the first hour, not day 4.

### Graceful Degradation

No single failure brings down the system. SimpleMem down → local memory only. Gmail auth expired → read-only mode, queue drafts. Ollama slow → skip local calls, queue for Claude batch. Vault unreachable → cached versions, queue writes. Each degraded state communicated clearly with automatic recovery when the service returns.

### Self-Improvement

The system runs its own retrospectives:

- What did I predict that was wrong? (Meeting prep that missed the actual agenda)
- What did I miss? (Information I had but didn't surface)
- What did I surface that wasn't useful? (Alerts ignored, briefing items not actionable)
- Where did agents disagree? (What happened after?)

These feed back into priority scoring, alert thresholds, and agent coordination. Not retraining — calibration of attention, urgency, and trust.

The loop inherits Marvin's `tasks/lessons.md` pattern — every correction generates a rule that prevents the same mistake. At scale, patterns across hundreds of interactions reveal calibration drift, coverage gaps, and emerging needs before they're reported.

---

## What Already Exists

| Component | Status | Source |
|-----------|--------|--------|
| Container isolation + crash recovery | Built | NanoClaw |
| Multi-agent teams (5 named personas) | Built | NanoClaw |
| Bot pool identities (Telegram swarm) | Built | NanoClaw |
| Filesystem IPC | Built | NanoClaw |
| Task scheduler (cron, interval, once) | Built | NanoClaw |
| Three-layer task validation (30-min minimum) | Built | NanoClaw |
| Credential proxy | Built | NanoClaw |
| Session continuity (resume + compaction) | Built | NanoClaw |
| MCP integrations (9 servers) | Built | NanoClaw |
| Group-scoped memory | Built | NanoClaw |
| SimpleMem (shared long-term memory) | Built | NanoClaw + Marvin |
| QMD search (1700+ docs indexed) | Built | NanoClaw |
| Obsidian vault with AGENTS.md governance | Built | Marvin |
| Contact tracking (collaborator profiles) | Built | Marvin |
| Email triage (8 categories, 3 priorities) | Built | Marvin |
| Meeting transcript processing (Granola) | Built | Marvin |
| Custom subagents (8 specialized agents) | Built | Marvin |
| Session workflow (/marvin, /end, /update) | Built | Marvin |
| Self-improvement loop (lessons.md) | Built | Marvin |
| PageIndex (PDF hierarchical indexing) | Built | NanoClaw |
| Remote control (spawn Claude Code via Telegram) | Built | NanoClaw |
| Sandbox execution model | Built | OpenClaw |
| Subagent orchestration framework | Built | OpenClaw |
| Delivery queue (reliable message routing) | Built | OpenClaw |
| Extension architecture (channel plugins) | Built | OpenClaw |
| Apple Notes MCP (search + CRUD) | Built | NanoClaw |
| Todoist MCP (task management) | Built | NanoClaw |
| Email sync (Exchange + Gmail → backup) | Built | NanoClaw |
| Calendar sync (Outlook → MJG-sync, dedup) | Built | NanoClaw + scheduleSync |
| Ollama (local inference, embeddings) | Running | Infrastructure |

---

## What Makes This Different

**It's event-driven, not request-response.** You don't ask it to check your email. Email arrives and is processed. You don't ask it to monitor preprints. New papers are read and assessed. The system is always working, not waiting.

**It's multi-agent with genuine coordination.** The agents have different tools, different memory, different trust levels, different autonomy boundaries, and they communicate with each other without you in the loop. Einstein's finding triggers Sep's evaluation triggers Claire's briefing, and you see the result, not the process.

**It's token-conscious by design.** The two-tier architecture isn't a compromise — it's the right design. Local models handle perception and classification. Claude handles judgment and creation. The system gets smarter not by using more tokens but by using them more precisely.

**It learns from observation, not instruction.** Your approval patterns become trust boundaries. Your scheduling preferences become constraints. Your writing style becomes its voice. Your priority intuitions become its ranking model. Over months, the gap between what it does autonomously and what you would have done narrows toward zero for routine decisions.

**It's built on local infrastructure, synced via Dropbox.** The vault, the memory systems, the agent processes — all local. Dropbox syncs across machines. The only external dependency is the LLM API. Everything else is yours.

---

## The Remaining Gap

The foundation is built. The gap between current state and the full vision:

**Event-driven perception.** Replace polling with push: Gmail webhooks, IMAP IDLE, calendar push notifications, Slack event subscriptions, filesystem watchers. Each event typed and routed through the bus. *This is plumbing — no research needed.*

**The Ollama tier.** Continuous local inference for classification, extraction, and routing. Structured JSON outputs feeding agent queues. Confidence-based escalation to Claude. *The models exist (already running for embeddings). The integration pipeline needs building.*

**The inter-agent message bus.** The filesystem-based pub/sub described above. Topic routing, subscription configs, atomic claim/complete. *Straightforward engineering on top of existing IPC.*

**The knowledge graph (Layer 5).** Entity extraction from all data sources, relationship tracking, temporal versioning. SQLite-backed, Ollama-maintained. *The most architecturally novel component — but well-understood in knowledge engineering.*

**The trust/autonomy framework.** The learned matrix of (agent, action, context) → autonomy level. Approval tracking, promotion suggestions, context-sensitive boundaries. *Requires careful safety engineering and thoughtful defaults.*

**Precomputed context injection.** Scripts that assemble each agent's context packet before the session starts, drawing from vault state, bus outputs, and Ollama's structured extractions. *Deterministic scripts — the hardest part is deciding what to include.*

**Judgment under ambiguity.** Knowing that a cold email thread means they're busy (wait) vs. losing interest (follow up now) vs. didn't see it (resend). Knowing that a student's quiet week is exam-related (normal) vs. disengagement (intervene). Current models can approximate this. The trust calibration system handles consequences of getting it wrong. The aspiration is genuine situational judgment that improves with every observed outcome.

**Coherent identity across time.** A human chief of staff who's been with you for 10 years has a continuous identity — they remember not just facts but the *feeling* of past interactions, the evolution of relationships, the way priorities shifted over seasons. Current agents have session-bounded identity stitched together with memory systems. The five-layer memory architecture is the foundation for continuity. What remains is making the stitching seamless enough that no session boundary is perceptible.

None of these are impossible. The foundation is built. The vision is clear. The path is incremental — each component delivers standalone value while moving toward the complete system. The question is assembly.
