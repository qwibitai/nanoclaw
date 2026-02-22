---
name: add-obsidian
description: Add Obsidian vault integration to NanoClaw. Enables reading, creating, editing, and searching notes in your Obsidian vault. Mounts vault directory for direct file access.
---

# Add Obsidian Integration

This skill adds access to your Obsidian vault, allowing Nano to work with your knowledge base.

## What You Can Do

Once configured:
- Read notes from your vault
- Create new notes
- Edit existing notes
- Search across all notes
- Follow wikilinks between notes
- Access daily notes
- Sync information between Obsidian and Nano's memory

## Prerequisites

### 1. Locate Your Obsidian Vault

Find your vault path:

```bash
# Common locations:
# macOS: ~/Documents/Obsidian Vault
# macOS iCloud: ~/Library/Mobile Documents/iCloud~md~obsidian/Documents/VaultName
# Linux: ~/Documents/Obsidian
# Windows: C:\Users\YourName\Documents\Obsidian
```

Ask the user for their vault path if not obvious.

### 2. Verify Vault Structure

```bash
ls -la "/path/to/obsidian/vault"
```

Should show `.obsidian/` folder and markdown files.

## Installation Steps

### 1. Mount Vault to NanoClaw Container

Edit the registered groups config to add vault mount:

```bash
# Read current config
cat /workspace/project/data/registered_groups.json
```

Add `containerConfig` to the main group (or relevant group):

```json
{
  "your-group-jid": {
    "name": "main",
    "folder": "main",
    "trigger": "@Nano",
    "containerConfig": {
      "additionalMounts": [
        {
          "hostPath": "/Users/username/Documents/Obsidian Vault",
          "containerPath": "obsidian",
          "readonly": false
        }
      ]
    }
  }
}
```

The vault will be accessible at `/workspace/extra/obsidian/` inside containers.

### 2. Create Obsidian Helper Functions

Create a helper file in Nano's workspace:

```bash
cat > /workspace/group/obsidian-helpers.md << 'EOF'
# Obsidian Vault Helpers

Vault location: `/workspace/extra/obsidian/`

## Common Operations

### List all notes
```bash
find /workspace/extra/obsidian -name "*.md" -type f | grep -v ".obsidian"
```

### Search for keyword
```bash
grep -r "keyword" /workspace/extra/obsidian --include="*.md" | grep -v ".obsidian"
```

### Read a note
```bash
cat "/workspace/extra/obsidian/path/to/note.md"
```

### Create a note
```bash
cat > "/workspace/extra/obsidian/NewNote.md" << 'NOTEEOF'
# Note Title

Content here
NOTEEOF
```

### Find notes by tag
```bash
grep -r "#tag" /workspace/extra/obsidian --include="*.md"
```

### Get daily note path
```bash
# Format: YYYY-MM-DD.md in Daily Notes folder
echo "/workspace/extra/obsidian/Daily Notes/$(date +%Y-%m-%d).md"
```

## Vault Structure

Update this section with user's actual vault structure:
- /Daily Notes/ - daily journal entries
- /Projects/ - project notes
- /Areas/ - areas of responsibility
- /Resources/ - reference material
- /Archive/ - old notes

## Common Note Templates

### Daily Note
```markdown
---
date: {{date}}
tags: daily-note
---

# {{date}}

## Tasks
- [ ]

## Notes


## Reflection

```

### Project Note
```markdown
---
project: {{title}}
status: active
tags: project
---

# {{title}}

## Overview

## Goals

## Tasks

## Resources

```
EOF
```

### 3. Restart NanoClaw

After adding the mount config, restart NanoClaw for the vault to be mounted.

### 4. Verify Access

Test that the vault is accessible:

```bash
ls -la /workspace/extra/obsidian/
find /workspace/extra/obsidian -name "*.md" | head -5
```

## Usage Examples

Once configured, you can ask:

- "What notes do I have about [topic]?"
- "Show me my daily note from yesterday"
- "Create a new project note for X"
- "Search my vault for mentions of Y"
- "Update my daily note with this task"
- "What's in my Projects folder?"

## Advanced Features

### Wikilink Resolution

When reading notes with wikilinks `[[Note Title]]`:

```bash
# Find note by title (case-insensitive)
find /workspace/extra/obsidian -iname "*note title*.md"
```

### Backlinks

Find all notes linking to a specific note:

```bash
grep -r "\[\[Note Title\]\]" /workspace/extra/obsidian --include="*.md"
```

### Tags Index

List all unique tags in vault:

```bash
grep -roh "#[a-zA-Z0-9_-]*" /workspace/extra/obsidian --include="*.md" | sort -u
```

### Recent Notes

Find recently modified notes:

```bash
find /workspace/extra/obsidian -name "*.md" -type f -mtime -7 | grep -v ".obsidian"
```

## Syncing with Nano's Memory

Create a sync strategy between Obsidian and Nano's workspace:

1. **Import from Obsidian**: Copy relevant notes to `/workspace/group/knowledge/`
2. **Export to Obsidian**: Create notes in vault from Nano's tracking
3. **Bidirectional**: Keep certain notes synced (e.g., goals, habits)

Example sync script:

```bash
# Copy goals from Obsidian to Nano's memory
cp /workspace/extra/obsidian/Goals/2026.md /workspace/group/metas-2026.md

# Create daily summary in Obsidian from Nano's tracking
cat > "/workspace/extra/obsidian/Daily Notes/$(date +%Y-%m-%d).md" << EOF
# $(date +%Y-%m-%d)

## Summary from Nano
$(cat /workspace/group/daily-summary-$(date +%Y-%m-%d).txt)
EOF
```

## Safety Notes

- Vault is mounted read-write by default
- Be careful with deletions
- Obsidian sync (if enabled) will sync changes
- Consider backing up vault before major operations
- Test with a dummy vault first if unsure

## Troubleshooting

### Vault not accessible

- Check mount path is correct
- Verify registered_groups.json syntax
- Ensure NanoClaw was restarted after config change
- Check permissions on vault directory

### Notes not found

- Verify vault structure matches expected paths
- Check for spaces in filenames (use quotes)
- Ensure .md extension is included

### Sync conflicts

- If using Obsidian Sync or iCloud, changes may conflict
- Close Obsidian when making bulk changes from Nano
- Use git versioning in vault for safety

## Next Steps

After setup:
1. Map out your vault structure in the helper file
2. Identify key notes to sync with Nano's memory
3. Create templates for common note types
4. Set up automated daily note creation if desired
