---
description: Claude Code plugin that generates complete knowledge systems from conversation, backed by 249 research claims
topics: [system-architecture, knowledge-management]
created: 2026-02-21
---

# Ars Contexta provides research-backed agent memory architecture

Ars Contexta is a Claude Code plugin that creates persistent knowledge systems for AI agents. Unlike template-based approaches, it derives complete cognitive architectures through conversation.

## Key Components

**Three-Space Separation**
- `self/`: Agent identity and methodology (permanent, slow-growing)
- `notes/`: Knowledge graph (permanent, steady growth)
- `ops/`: Operational scaffolding (temporal, rotating)

**Processing Pipeline (The 6 Rs)**
- Record → Reduce → Reflect → Reweave → Verify → Rethink
- Each phase runs in fresh context to avoid attention degradation

**Discovery-First Design**
- Everything created must be optimized for future agent discovery
- "If an agent can't find a note, the note doesn't exist"

**Research Grounding**
- 249 interconnected research claims in methodology directory
- Every architectural decision traces to specific cognitive science research
- Synthesizes Zettelkasten, Cornell Note-Taking, GTD, memory palaces, network theory

## Why It Matters

Most AI tools start every session blank. Ars Contexta creates persistent thinking systems that:
- Remember identity and methodology across sessions
- Build knowledge graphs that compound through connections
- Self-improve through friction detection and operational learning

## Integration Strategy

For this WhatsApp bot, we're adapting the principles:
1. Three-space architecture (self/, memory/, ops/)
2. Discovery-first memory design
3. Processing commands (/remember, /reflect, /review)
4. Session rhythm (orient, work, persist)

## References

- Repository: https://github.com/agenticnotetaking/arscontexta
- Core primitives defined in `reference/kernel.yaml`
- Architecture spec in `reference/three-spaces.md`

## Related Notes

- [[User wants discovery-first memory design]]

---

*Topics: [[system-architecture]] · [[knowledge-management]]*
