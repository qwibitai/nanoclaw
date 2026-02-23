# /reflect

Find connections between notes and maintain the knowledge graph.

## Process

1. **Inventory**: Read all notes in `groups/main/memory/` (excluding `index.md`)
2. **Analyze connections**:
   - Parse existing `[[wiki links]]` in each note
   - Compare note content for topical overlap
   - Identify notes that reference similar concepts but don't link to each other
3. **Update cross-references**: For each pair of related but unlinked notes:
   - Add `[[link]]` in the "Related Notes" section of each note
4. **Update index.md**:
   - Ensure every note on disk appears in `groups/main/memory/index.md`
   - Group notes into topic sections based on their `topics` frontmatter
   - Reorder "Recent Additions" by date
5. **Suggest MOCs**: If any topic has 5+ notes, suggest creating a dedicated topic MOC file
6. **Report**: Summarize what was found:
   ```
   Knowledge Graph Status:
   - X notes total
   - Y new connections added
   - Z orphan notes (no links to/from other notes)
   - Topic coverage: [list topics with note counts]
   - Suggested MOCs: [topics with 5+ notes]
   ```

## What to look for

- **Orphan notes**: Notes with no wiki-links to or from other notes
- **Missing links**: Notes that discuss the same topic but don't reference each other
- **Stale index**: Notes on disk that aren't listed in `index.md`
- **Topic gaps**: Notes whose `topics` frontmatter suggests a category not yet in the index
- **Clusters**: Groups of highly-interconnected notes that could benefit from a MOC

## Rules

- **Read-only first**: Analyze and present findings before making changes
- **Preserve existing links**: Never remove wiki-links, only add new ones
- **Don't create notes**: This skill maintains connections, not content. Use `/remember` to create new notes.
- **Respect three-space boundaries**: Only work with `memory/` content. Don't cross-link to `self/` or `ops/` files.
