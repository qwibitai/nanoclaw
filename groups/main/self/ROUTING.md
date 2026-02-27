# Task Routing & Module Loading

Level 1 routing: Determines which modules and context to load based on task type.

## Progressive Disclosure Pattern

**Three levels of context loading:**

1. **Level 1 (This file)**: Lightweight routing - always loaded, maps task → module
2. **Level 2**: Module-specific context - loaded only when module is relevant
3. **Level 3**: Actual data - loaded only when task requires it

**Goal**: Maximum 2 hops to any information. Prevent attention dilution and lost-in-middle effect.

---

## Task Categories & Routing

### Communication Tasks

**Triggers**: User asks questions, requests explanations, casual conversation

**Load**:
- `self/voice.yaml` (communication style, banned words)
- `self/identity.md` (who you are)
- `users/{contact_id}.md` if addressing specific user

**Skip**: memory/logs (unless specifically asked about history)

**Quality gates**:
- Check banned words from voice.yaml
- Lead with answer (no preambles)
- Progressive disclosure (brief first, elaborate if asked)

---

### Memory & Knowledge Tasks

**Triggers**: `/remember`, `/reflect`, "save this", "remember that", "what did we discuss about X"

**Load Level 2**:
- `memory/index.md` (what exists)
- `self/methodology.md` (routing rules: memory/ vs self/ vs ops/)

**Load Level 3** (as needed):
- Search `memory/*.md` for relevant notes
- Query `memory/logs/*.jsonl` for specific records
- Cross-reference via IDs (see `memory/CROSS_REFERENCES.md`)

**Quality gates**:
- Check for duplicates before creating notes
- Use prose-sentence titles
- Update index.md
- Link related notes

---

### Code & Development Tasks

**Triggers**: "build", "implement", "fix bug", "create feature", self-editing

**Load Level 2**:
- `self/methodology.md` (development principles)
- Project-specific CLAUDE.md if working on NanoClaw source

**Load Level 3**:
- Relevant source files
- Tests
- Documentation

**Skills**:
- `/self-edit` for modifying NanoClaw source (see `.claude/skills/self-edit/`)

**Quality gates**:
- Read before edit/write
- Run tests after changes
- Update documentation
- Follow existing patterns

---

### Research & Web Tasks

**Triggers**: "search for", "find information about", "what's happening with", URLs provided

**Load Level 2**:
- `self/voice.yaml` (how to present findings)

**Tools**:
- `WebSearch` for current events
- `WebFetch` for specific URLs
- `agent-browser` for interactive web tasks

**Skills**:
- `/topic-research` (future: structured research with evidence collection)

**Quality gates**:
- Cite sources
- Grade source reliability (HIGH/MEDIUM/LOW)
- Save research to `memory/research/{topic}.md`

---

### Content Creation Tasks

**Triggers**: "write blog", "create post", "draft email", content workflows

**Load Level 2**:
- `self/voice.yaml` (5-axis scores, banned words, signature patterns)
- `templates/` (if exists - blog, email, thread templates)

**Load Level 3** (as needed):
- `memory/research/{topic}.md` for background
- `memory/logs/posts.jsonl` to avoid repeating recent topics

**Skills**:
- `/write-blog` (future: 7-section template with multi-pass editing)
- `/create-thread` (future: Twitter/LinkedIn thread formatting)

**Quality gates** (from voice.yaml):
- Banned words check
- Structural patterns check
- Quality checkpoints every 500 words
- Read-aloud test

---

### Planning & Review Tasks

**Triggers**: "what should I work on", "weekly review", "update goals", session end

**Load Level 2**:
- `self/goals.md` (current priorities, active threads)
- `ops/reminders.md` (time-bound actions)

**Load Level 3** (as needed):
- `memory/logs/decisions.jsonl` (past decisions for context)
- `memory/logs/experiences.jsonl` (what mattered before)
- `ops/sessions/` (recent work patterns)

**Skills**:
- `/weekly-review` (future: metrics + stale contacts + goal check)

**Quality gates**:
- Update goals.md with completed work
- Identify next actions
- Surface stale priorities

---

### Relationship & Contact Tasks

**Triggers**: "prepare for meeting with X", "who should I reach out to", "log this interaction"

**Load Level 2**:
- `users/{contact_id}.md` (profile)
- `memory/CROSS_REFERENCES.md` (how to traverse)

**Load Level 3**:
- `memory/logs/interactions.jsonl` (filtered by contact_id)
- `ops/todos.md` (pending items involving contact)

**Skills**:
- `/meeting-prep` (future: compile brief from contacts + interactions + todos)

**Quality gates**:
- Use consistent contact_id across files
- Log interactions to interactions.jsonl
- Update sentiment tracking
- Identify follow-up actions

---

### System Management Tasks

**Triggers**: "add user", "register group", "self-update", "schedule task", admin operations

**Load Level 2**:
- Admin section of CLAUDE.md (main group only)
- `self/methodology.md` (operational procedures)

**Quality gates**:
- Verify permissions (main group only for privileged ops)
- Follow documented procedures
- Log significant changes to ops/observations/

---

## Auto-Loading Context (Always Active)

These load for ALL tasks as baseline:

- `self/voice.yaml` (communication guidelines)
- `self/identity.md` (who you are)
- `memory/index.md` (knowledge map - lightweight, just titles and topics)

**Why always load these?**
- Voice: Ensures consistent communication across all task types
- Identity: Maintains consistent persona and role
- Index: Enables quick "do I already know about X?" checks

---

## Context Budget Management

**Problem**: Language models have finite attention. Every token competes.

**Solution**: Scoped loading based on task type.

**Example: User asks to write a blog post**

**Load** (relevant):
- voice.yaml (how to write)
- blog template (structure)
- research on topic (if exists)

**Skip** (irrelevant):
- interactions.jsonl (not a relationship task)
- system admin docs (not managing infrastructure)
- other content templates (not writing email/thread)

Result: ~2,000 tokens of relevant context vs. ~10,000 tokens if everything loaded.

---

## Decision Table

Quick reference for common requests:

| User Says | Load Module | Load Data | Tools/Skills |
|-----------|-------------|-----------|--------------|
| "Remember this..." | Memory system | memory/index.md | /remember |
| "What did we discuss about X?" | Memory system | memory/*.md + logs | Grep, Read |
| "Write a blog about Y" | Content creation | voice.yaml + templates | /write-blog |
| "Search for Z" | Research | voice.yaml | WebSearch |
| "Prepare for meeting with Sarah" | Relationships | users/sarah.md + interactions | /meeting-prep |
| "What should I work on?" | Planning | goals.md + reminders.md | - |
| "Add new user" | System admin | CLAUDE.md admin section | SQLite |
| "Build fitness app" | Development | methodology.md | EnterPlanMode |

---

## Module Boundaries

**Why modules matter**: Every module boundary is a loading decision.

**Current modules**:
- `self/` - Agent identity, voice, methodology, goals
- `memory/` - User knowledge graph
  - `memory/logs/` - JSONL append-only episodic memory
  - `memory/research/` - Topic research documents
- `ops/` - Operational coordination (sessions, observations, reminders)
- `users/` - Contact profiles
- `templates/` (future) - Content templates
- `projects/` (future) - Active project files

**Get boundaries wrong** → Load too much (context bloat) or too little (missing key info)

**Get boundaries right** → Load exactly what's needed, nothing more

---

## Implementation Notes

This routing system is declarative. When you receive a task:

1. **Identify task type** (use decision table)
2. **Load Level 2 context** (module-specific docs)
3. **Load Level 3 data** (only if needed)
4. **Execute with quality gates** (from loaded context)
5. **Persist learnings** (update goals, create memories, log friction)

The system prevents you from loading everything upfront, which would:
- Dilute attention on what matters
- Trigger lost-in-middle effect
- Slow down processing
- Increase cognitive load

Instead: Route → Module → Data. Maximum 2 hops to any information.
