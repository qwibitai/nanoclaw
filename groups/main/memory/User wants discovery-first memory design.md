---
description: Every piece of knowledge must be optimized for future agent discoverability
topics: [memory-design, principles]
created: 2026-02-21
---

# User wants discovery-first memory design

Before creating any memory or note, the agent must ask: "How will a future session find this?"

## Core Principle

From Ars Contexta: "If an agent can't find a note, the note doesn't exist."

Every piece of knowledge must be:
- **Discoverable**: Clear title, description, connections
- **Composable**: Can be linked with other knowledge
- **Durable**: Worth finding again in the future

## Implementation

**Before creating any memory:**
1. Consider how it will be found (search terms, connections, MOC placement)
2. Write a prose-sentence title that makes a claim
3. Add a ~150 char description for progressive disclosure
4. Link to related notes
5. Tag with topics for navigation

**Memory structure:**
- Flat directory (no nested folders)
- Wiki-style links `[[note title]]`
- YAML frontmatter with metadata
- Index MOC for navigation

## Quality Gate

Discovery-first is a quality gate, not a feature request. Notes that can't be discovered create negative value - they exist but can't be found.

## Application

This principle applies to:
- User preferences and facts
- Conversation insights
- System learnings
- Operational observations (before promoting from ops/ to memory/)

## Related Notes

- [[Ars Contexta provides research-backed agent memory architecture]]
- [[User prefers single asterisks for bold in WhatsApp messages]]

---

*Topics: [[memory-design]] · [[principles]]*
