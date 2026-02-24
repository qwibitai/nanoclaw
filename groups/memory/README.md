# Memory Vault

This is the shared memory vault. It is mounted at `/workspace/memory/` in every container:
- **Main group**: read-write (can create and update files)
- **All other groups**: read-only (can recall context)

Open this folder in Obsidian for a visual knowledge graph.

## Structure

| Folder | Purpose |
|--------|---------|
| `People/` | One page per person — contact info, preferences, open commitments, interaction log |
| `Companies/` | One page per company/org |
| `Projects/` | Active and past projects |
| `Daily Notes/` | Date-stamped notes (YYYY-MM-DD.md) |
| `Learning/` | Observed preferences, recurring mistakes, patterns |

## When to Update (agent instructions)

See `/workspace/global/CLAUDE.md` → Memory section.
