# Cross-Module Reference System

This document defines the ID linking system that enables knowledge graph traversal without loading the entire system.

## Core Principle

**Modules are isolated for loading, but connected for reasoning.**

Cross-references allow the AI to "join" data across files like a relational database, but with flat files.

## ID Schemes

### User/Contact IDs
- **Format**: `user_{phone}` or `{username}`
- **Used in**:
  - `users/{id}.md` (profile files)
  - `memory/logs/interactions.jsonl` (`contact_id` field)
  - Future: contacts.jsonl, meetings.jsonl

**Example:**
```json
{"id": "int_001", "contact_id": "admin", "summary": "Discussed fitness app"}
```

### Experience IDs
- **Format**: `exp_{###}`
- **Used in**: `memory/logs/experiences.jsonl`
- **References**: Can reference `contact_id`, `decision_id`

### Decision IDs
- **Format**: `dec_{###}`
- **Used in**: `memory/logs/decisions.jsonl`
- **Referenced by**: experiences.jsonl, failures.jsonl

### Failure IDs
- **Format**: `fail_{###}`
- **Used in**: `memory/logs/failures.jsonl`
- **References**: Can reference `decision_id`

### Content IDs (future)
- **Format**: `post_{###}`, `idea_{###}`
- **Used in**: posts.jsonl, ideas.jsonl
- **References**: topics, contacts

## Reference Patterns

### Foreign Key Pattern

```json
// interactions.jsonl
{"id": "int_001", "contact_id": "admin", ...}

// To resolve, AI reads:
// 1. users/admin.md for contact profile
// 2. Filter interactions.jsonl for contact_id="admin"
```

### Many-to-Many with Tags

```json
// decisions.jsonl
{"id": "dec_001", "tags": ["technical", "architecture"], ...}

// experiences.jsonl
{"id": "exp_001", "tags": ["technical"], "related_decisions": ["dec_001"]}
```

### Temporal References

```json
// failures.jsonl
{
  "id": "fail_001",
  "what_happened": "Lost 3 months of data",
  "related_decisions": ["dec_005"],
  "prevention": "Switch to append-only JSONL"
}
```

## Traversal Examples

### Example 1: Meeting Prep

**User request:** "Prepare for my meeting with Sarah"

**AI traversal:**
1. Search `users/` for Sarah's profile → `users/sarah.md`
2. Read profile for context (role, relationship, preferences)
3. Query `interactions.jsonl` for `contact_id=sarah`
4. Check `todos.md` for pending items mentioning Sarah
5. Compile brief with: relationship context + recent interactions + action items

### Example 2: Decision Review

**User request:** "Why did I choose X over Y last month?"

**AI traversal:**
1. Search `decisions.jsonl` for keywords X, Y
2. Find decision with matching terms
3. Read decision reasoning, alternatives, framework
4. Check `related_experiences` for emotional context
5. Check outcome field for results

### Example 3: Pattern Recognition

**User request:** "Show me failures related to data storage"

**AI traversal:**
1. Search `failures.jsonl` for `tags` containing "data" or "storage"
2. For each failure, check `related_decisions` field
3. Pull referenced decisions from `decisions.jsonl`
4. Identify common patterns in root causes
5. Summarize prevention strategies

## Implementation Guidelines

### For AI Agents

When you need cross-module data:

1. **Identify the anchor**: What's the starting point? (contact_id, decision_id, tag)
2. **Load only relevant files**: Don't load everything, traverse references
3. **Follow the chain**: Each reference points to next file to read
4. **Maximum 3 hops**: If you need more than 3 file jumps, the architecture needs rethinking

### For Humans Adding Data

When adding new log entries:

1. **Use consistent IDs**: Follow the format conventions
2. **Add cross-references**: If related to existing decision/experience, link it
3. **Tag appropriately**: Tags enable topic-based queries
4. **Include temporal markers**: Dates help with "when did I..." queries

### Schema Enforcement

Each JSONL file's first line defines the schema:

```json
{"_schema": "interaction", "_version": "1.0", "_fields": ["id", "date", "contact_id", "summary", "sentiment", "topics", "follow_up", "status"]}
```

AI should validate against schema before appending.

## Benefits

- **No database required**: Everything is Git-versionable
- **Human-readable**: Can grep/search without special tools
- **Agent-friendly**: Clear reference paths
- **Selective loading**: Load only what's needed for the task
- **Composable**: Build complex queries by chaining references

## Future Enhancements

As the system grows, consider adding:

- **contacts.jsonl**: Full contact management with `can_help_with` / `you_can_help_with` fields
- **posts.jsonl**: Published content with engagement metrics
- **ideas.jsonl**: Content ideas with scoring system
- **meetings.jsonl**: Meeting notes with attendees (contact_ids) and outcomes
- **projects.jsonl**: Multi-step projects with task lists

Each would follow the same cross-reference patterns.
