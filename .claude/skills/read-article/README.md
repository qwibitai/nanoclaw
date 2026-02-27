# Read Article Skill

Automates the process of reading external articles and integrating learnings into NanoClaw's knowledge base.

## Quick Start

```bash
/read-article <url>
```

## What It Does

1. **Reads the article** using agent-browser or WebFetch
2. **Extracts key learnings** categorized by applicability (Tier 1: immediate, Tier 2: strategic, Tier 3: reference)
3. **Creates memory notes** for each key concept with proper linking
4. **Applies improvements** to the system (if user confirms)
5. **Documents everything** in research summary

## Example Output

```
✅ Read: "The File System Is the New Database"
📝 Created 6 memory notes
🔧 Implemented 5 improvements
📊 Research summary: memory/research/2026-02-24-file-system-database.md
```

## Files Created

- `memory/<Concept>.md` - One note per key learning
- `memory/research/YYYY-MM-DD-article-title.md` - Full research summary
- `ops/observations/YYYY-MM-DD-article-applied.md` - Change log (if improvements applied)
- Updated `memory/index.md`

## Use Cases

- **Learn from thought leaders**: Read articles by AI researchers, practitioners
- **Integrate best practices**: Apply external knowledge to improve NanoClaw
- **Build knowledge graph**: Systematically consume and connect ideas
- **Document research**: Keep track of what you've read and applied

## Quality Gates

✅ Checks for duplicate notes before creating
✅ Links related concepts via wiki-style references
✅ Preserves source attribution
✅ Asks before applying changes to system
✅ Documents all changes in observations

## See Also

- `/remember` - Capture learnings from conversations
- `/reflect` - Maintain knowledge graph connections
