# Skill Graphs — Navigable Knowledge for Agent Skills

> Concept document for structured, graph-based skill organization in OpenClaw.
> Status: Proposal (prototype built for Komodo skill)
> Inspired by: [Ars Contexta](https://github.com/agenticnotetaking/arscontexta) skill graph concept

## Problem

Agent skills today are flat files. One SKILL.md per capability, loaded in full whenever the agent needs any part of it. This creates three problems:

### 1. Token waste
A Postiz SKILL.md is 400+ lines. To schedule one LinkedIn post, the agent loads everything — Twitter thread creation, Bluesky character limits, error monitoring, media upload. Most of it is irrelevant to the task at hand.

### 2. Poor discovery
Skills are listed by name and a one-line description in the system prompt. The agent must decide whether to load a skill based on that description alone. If the description doesn't match the user's phrasing, the skill gets skipped. Complex skills with multiple capabilities are especially hard to discover — "Komodo" doesn't obviously map to "restart my Postiz container."

A critical variant of this problem: **ownership mapping.** When all Docker containers are managed through Komodo, the agent needs to know that any Docker-related request means "use Komodo," not raw `docker` commands. The INDEX.md can state this ownership explicitly ("All Docker containers on aiserver are managed through Komodo"), creating a reliable mapping from user intent to skill selection.

### 3. No context awareness
Skills describe generic capabilities but not what they manage. A Komodo skill knows how to call `DeployStack` but doesn't know which stacks exist, what they do, or how they relate to each other. That context lives in separate files (TOOLS.md, MEMORY.md) or in the agent's training data, disconnected from the skill.

## Solution: Skill Graphs

Replace flat SKILL.md files with a small graph of interconnected markdown files. Each file captures one focused concept. Links between files tell the agent when and why to follow a connection.

### Structure

```
skills/<skill-name>/
├── INDEX.md              ← Entry point: capabilities, target table, links
├── SKILL.md              ← Legacy flat file (optional, kept for backward compat)
├── <topic>.md            ← Focused reference nodes (API, auth, workflows)
└── targets/
    ├── <target-a>.md     ← What the skill manages: IDs, URLs, deps, procedures
    └── <target-b>.md
```

### Key Principles

**1. INDEX.md is the entry point**
Always small (< 50 lines). Lists capabilities with links to detail nodes. The agent reads this first and decides which nodes to follow. Most decisions happen here without reading any detail file.

**2. Detail nodes are standalone but linked**
Each node (api.md, targets/postiz.md) is self-contained — useful on its own. But wikilinks to other nodes provide traversable context. A target node links back to the API reference it uses. The API reference links to targets it manages.

**3. Targets are the context layer**
Target nodes describe what the skill actually manages in your specific environment. They contain IDs, URLs, dependencies, restart procedures, and relations to other skills. This is where generic skill knowledge meets your infrastructure.

**4. Cross-skill relations**
Target nodes can link to other skills' INDEX.md files. A Komodo target for Postiz links to the Postiz API skill. A Wix blog target links to the Postiz skill for social promotion. These cross-references create a workspace-wide knowledge graph.

## How the Agent Uses It

### Current flow (flat SKILL.md)
```
User: "restart Postiz"
Agent: Scan available_skills → no obvious match for "Postiz"
       OR: Load full SKILL.md (155 lines) → find restart command
       OR: Skip skill entirely, use raw docker commands
```

### Skill graph flow
```
User: "restart Postiz"
Agent: Read INDEX.md (35 lines) → see "postiz" in target table
       Read targets/postiz.md (27 lines) → stack name, restart command, deps
       Execute restart
       Total: 62 lines loaded instead of 155
```

### Cross-skill navigation
```
User: "publish a blog post and promote it on social"
Agent: Read wix-api/INDEX.md → blog operations
       Read wix-api/blog/posts.md → create/publish flow
       Read wix-api/targets/adultintraining.md → site ID, legal constraints, CTA standard
       Follow link → postiz/INDEX.md → scheduling
       Read postiz/targets/linkedin.md → char limits, no hashtags
       Read postiz/targets/twitter.md → 280 char limit, thread rules
       Total: ~150 lines across 6 focused files
       vs: loading two full SKILL.md files (~600+ lines combined)
```

## Benefits

### Token efficiency
Load only what's relevant. For simple tasks (restart a service, check a status), the agent reads INDEX.md + one target node. For complex tasks, it follows links to exactly the nodes it needs.

### Better discovery
INDEX.md lists capabilities *and* targets. When the user says "restart Postiz", the target table in the Komodo INDEX.md matches even though "Postiz" isn't in the skill name or description. The target layer bridges the gap between what the user says and what the skill can do.

### Context-aware operations
The agent knows not just *how* to restart a stack, but *what* the stack does, what depends on it, and what else might be affected. A Traefik target node says "⚠️ Do not restart without checking dependent services" — context that a generic API reference can't provide.

### Cross-skill workflows
Wikilinks between skills make multi-step workflows navigable. The agent doesn't need to know the full workflow in advance — it discovers related skills by following links from target nodes. The blog-to-social pipeline emerges from the graph structure.

### Maintainability
Small, focused files are easier to update than monolithic SKILL.md files. Adding a new Docker stack means creating one target node — no need to touch the API reference or INDEX.md (though adding it to the target table is good practice).

## When to Use Skill Graphs vs Flat SKILL.md

Not every skill needs a graph. The decision depends on complexity and context:

| Skill type | Recommendation | Example |
|---|---|---|
| Simple, single-purpose | Flat SKILL.md | Weather, TTS, image generation |
| Multi-capability API | Skill graph | Wix API, Postiz, Home Assistant |
| Infrastructure management | Skill graph + targets | Komodo, n8n workflows |
| Context-dependent operations | Skill graph + targets | Anything with environment-specific config |

**Rule of thumb:** If the SKILL.md is > 100 lines or the skill manages identifiable targets (servers, accounts, services), it benefits from a graph.

## Relation to Memory Architecture

Skill graphs complement the existing memory layers:

```
┌──────────────────────────────────────────────────┐
│              SESSION CONTEXT                      │
├──────────────────────────────────────────────────┤
│                                                   │
│  ┌─────────────┐  ┌─────────────┐                │
│  │  MEMORY.md  │  │   USER.md   │                │
│  │  (what I    │  │  (who you   │                │
│  │   know)     │  │   are)      │                │
│  └──────┬──────┘  └─────────────┘                │
│         │                                         │
│  ┌──────┴──────────────────────────────────────┐ │
│  │          KNOWLEDGE GRAPH (facts.db)          │ │
│  │   Entities, relations, activation, decay     │ │
│  └──────┬──────────────────────────────────────┘ │
│         │                                         │
│  ┌──────┴──────────────────────────────────────┐ │
│  │            SKILL GRAPHS                      │ │
│  │   INDEX.md → detail nodes → target nodes     │ │
│  │   Cross-skill links → workflow discovery     │ │
│  │   Environment context (IDs, URLs, deps)      │ │
│  └──────────────────────────────────────────────┘ │
│                                                   │
│  ┌──────────────────────────────────────────────┐ │
│  │         SEMANTIC SEARCH (embeddings)          │ │
│  │   Continuity plugin, conversation archives    │ │
│  └──────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────┘
```

- **facts.db** stores structured facts (entities, relations, activation). It's the *what*.
- **Skill graphs** store operational knowledge (how to do things, with what). It's the *how*.
- **Target nodes** in skill graphs can reference entities in facts.db. A Postiz target node describes the stack; facts.db knows "Postiz.type = Social media scheduler."
- **Semantic search** finds relevant conversation history. Skill graphs find relevant operational procedures.

## Implementation Notes

### File format
Plain markdown with YAML frontmatter (optional) and wikilinks. No special tooling required — any agent that can read files can navigate the graph.

### Wikilink convention
```markdown
[[api#read-operations]]       ← link to section within same skill
[[targets/postiz]]            ← link to target node
[[../../postiz/INDEX]]        ← cross-skill link (relative path)
```

### INDEX.md template
```markdown
# <Skill Name> — <One-line description>

<2-3 sentence overview>

## Capabilities
- **<Capability>** → [[detail-node]]
- **<Capability>** → [[detail-node#section]]

## Targets
| Name | State | Purpose | Details |
|------|-------|---------|---------|
| target-a | running | Description | [[targets/target-a]] |

## Quick Reference
- **Key config**: where to find auth/config
- **Base URL**: primary endpoint

## Related Skills
- [[../other-skill/INDEX]] — how they connect
```

### Target node template
```markdown
# <Target Name> — <One-line description>

- **ID**: <identifier>
- **URL**: <access URL>
- **State**: <current state>

## What it does
<2-3 sentences>

## Dependencies
- <Dependency> → [[other-target]]

## Common operations
<Most frequent commands/procedures for this target>

## Related
- [[../../other-skill/INDEX]] — cross-skill link
```

## Prototype

A working prototype exists for the Komodo skill at `~/clawd/skills/komodo/`:

```
skills/komodo/
├── INDEX.md              (35 lines)
├── api.md                (77 lines)
├── SKILL.md              (155 lines, legacy)
└── targets/
    ├── postiz.md         (27 lines, links to Postiz skill)
    ├── n8n.md            (22 lines, links to content sheet)
    ├── llama-embed.md    (32 lines, documents GPU embedding server)
    ├── ollama.md         (20 lines, lists available models)
    ├── traefik.md        (17 lines, routes + dependency warning)
    ├── openwebui.md      (11 lines, depends on ollama)
    ├── monitoring.md     (8 lines)
    └── ghost.md          (8 lines)
```

## Open Questions

1. **Should INDEX.md be auto-injected into the system prompt?** Currently skills are listed by name + description. If INDEX.md files were included (or summarized), discovery would improve without the agent needing to read anything.

2. **Should target nodes be auto-populated?** A Komodo skill graph could query the API on startup and generate target nodes for discovered stacks. This keeps the graph in sync with reality.

3. **How do skill graphs interact with ClawHub?** Published skills on ClawHub would include the graph structure but not target nodes (those are environment-specific). Users would populate targets after install.

4. **Should the knowledge graph (facts.db) index skill graph nodes?** If target nodes were indexed as facts, the graph-memory plugin could surface relevant skill context alongside entity facts.

---

*Concept: 2026-02-21 | Prototype: Komodo skill graph | Author: Gandalf*
