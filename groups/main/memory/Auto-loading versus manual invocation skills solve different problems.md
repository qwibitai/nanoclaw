---
description: Skills architecture - reference skills inject automatically while task skills require explicit invocation for precision
topics: [skills, context-engineering, ai-agents]
created: 2026-02-24
---

# Auto-loading versus manual invocation skills solve different problems

Two types of skills with different loading mechanisms:

**Auto-loading skills (Reference)**
- YAML: `user-invocable: false`
- Agent reads description and injects automatically when task matches
- Examples: `voice-guide`, `writing-anti-patterns`, `style-checklist`
- **Solves consistency problem**: Don't have to remember to say "use my voice" every time

**Manual invocation skills (Task)**
- YAML: `disable-model-invocation: true`
- Agent cannot trigger on its own
- User types slash command: `/write-blog`, `/topic-research`, `/content-workflow`
- Skill becomes agent's complete instruction set for that task
- **Solves precision problem**: Different quality gates for different workflows

**Why separate them:**
- Research task has different quality gates than blog post
- Prevents agent from conflating two different workflows
- Auto-loading ensures baseline context, manual ensures specialized execution

**Single slash command triggers full context assembly:**
`/write-blog context engineering` loads:
1. Voice guide (how to write)
2. Anti-patterns (what to avoid)
3. Blog template (7-section structure with word counts)
4. Persona folder (audience profiles)
5. Research folder (existing topic research)

**Key principle:**
- Skill file references source module: "Read `brand/tone-of-voice.md`"
- Never duplicates content
- Single source of truth

## Related Notes
- [[Progressive disclosure uses three-level architecture for AI context]]
- [[Voice profiles should be structured data not adjectives]]

---
*Topics: [[skills]] · [[context-engineering]] · [[ai-agents]]*
