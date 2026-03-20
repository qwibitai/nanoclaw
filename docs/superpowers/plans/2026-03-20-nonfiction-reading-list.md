# Non-Fiction Reading List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Zotero-backed non-fiction reading list system with a CLI tool, a prioritization skill, and literature monitor integration.

**Architecture:** A Python CLI tool (`zotero-cli`) wraps pyzotero for read/write Zotero Web API access. A new `reading-list` container skill runs twice weekly, reads project context, manages the Zotero "To Read" collection, and outputs a prioritized vault note + WhatsApp message. The existing literature-monitoring skill gains a step to push must-read papers into Zotero.

**Tech Stack:** Python 3 + pyzotero, NanoClaw container skills (markdown), Docker, Zotero Web API

**Spec:** `docs/superpowers/specs/2026-03-20-nonfiction-reading-list-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `container/tools/zotero-cli/zotero_cli.py` | Create | CLI tool — all Zotero Web API operations |
| `container/tools/zotero-cli/requirements.txt` | Create | Python dependencies (pyzotero) |
| `container/tools/zotero-cli/test_zotero_cli.py` | Create | Unit tests for CLI tool |
| `container/Dockerfile` | Modify | Add python3, pip, pyzotero, copy CLI tool |
| `src/container-runner.ts` | Modify:243-255 | Inject ZOTERO_API_KEY and ZOTERO_LIBRARY_ID |
| `container/skills/reading-list/SKILL.md` | Create | Reading list skill definition |
| `.claude/skills/shoggoth/reading-list.md` | Create | Mirror of reading-list skill for host-side |
| `container/skills/literature-monitoring/SKILL.md` | Modify | Add step 6 (Zotero push) |
| `.claude/skills/shoggoth/literature-monitoring.md` | Modify | Mirror of literature-monitoring changes |
| `groups/global/CLAUDE.md` | Modify | Add reading-list skill to capabilities table |

---

### Task 1: Create `zotero-cli` Python tool

**Files:**
- Create: `container/tools/zotero-cli/zotero_cli.py`
- Create: `container/tools/zotero-cli/requirements.txt`
- Create: `container/tools/zotero-cli/test_zotero_cli.py`

- [ ] **Step 1: Create requirements.txt**

```
pyzotero>=1.5.0
```

- [ ] **Step 2: Write the test file with unit tests**

Create `container/tools/zotero-cli/test_zotero_cli.py`. Tests should mock pyzotero to avoid needing real API credentials. Cover:
- `search` command returns JSON array of items
- `add` command creates an item and adds it to a collection
- `list` command returns items from a collection
- `add-to` command adds an existing item to a collection
- `remove` command removes an item from a collection
- `collections` command lists all collections
- Missing env vars produce a clear error message
- `--format text` produces human-readable output
- Invalid commands produce usage help

Use `unittest.mock.patch` to mock `pyzotero.zotero.Zotero`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd /home/square/shoggoth/container/tools/zotero-cli && pip install pyzotero && python -m pytest test_zotero_cli.py -v`
Expected: FAIL — `zotero_cli.py` does not exist yet

- [ ] **Step 4: Write the CLI tool**

Create `container/tools/zotero-cli/zotero_cli.py`. Structure:

```python
#!/usr/bin/env python3
"""Zotero CLI — read/write access to Zotero library via Web API."""

import argparse
import json
import os
import sys
from pyzotero import zotero


def get_client():
    """Create Zotero client from environment variables."""
    api_key = os.environ.get('ZOTERO_API_KEY')
    library_id = os.environ.get('ZOTERO_LIBRARY_ID')
    if not api_key or not library_id:
        print("Error: ZOTERO_API_KEY and ZOTERO_LIBRARY_ID must be set", file=sys.stderr)
        sys.exit(1)
    return zotero.Zotero(library_id, 'user', api_key)


def find_collection_key(zot, name):
    """Find collection key by name (case-insensitive)."""
    for col in zot.collections():
        if col['data']['name'].lower() == name.lower():
            return col['key']
    return None


def cmd_search(args):
    """Search library for items matching query."""
    zot = get_client()
    items = zot.items(q=args.query, limit=args.limit)
    results = [{
        'key': item['key'],
        'title': item['data'].get('title', ''),
        'creators': [c.get('lastName', c.get('name', '')) for c in item['data'].get('creators', [])],
        'date': item['data'].get('date', ''),
        'itemType': item['data'].get('itemType', ''),
        'DOI': item['data'].get('DOI', ''),
        'url': item['data'].get('url', ''),
        'extra': item['data'].get('extra', ''),
    } for item in items]
    output(results, args.format)


def cmd_add(args):
    """Add a new item to the library, optionally to a collection."""
    zot = get_client()
    creators = []
    if args.authors:
        for author in args.authors.split(';'):
            parts = author.strip().rsplit(' ', 1)
            if len(parts) == 2:
                creators.append({'creatorType': 'author', 'firstName': parts[0], 'lastName': parts[1]})
            else:
                creators.append({'creatorType': 'author', 'name': parts[0]})

    item = {
        'itemType': args.type or 'journalArticle',
        'title': args.title,
        'creators': creators,
    }
    if args.doi:
        item['DOI'] = args.doi
    if args.url:
        item['url'] = args.url
    if args.note:
        item['extra'] = args.note

    collection_key = None
    if args.collection:
        collection_key = find_collection_key(zot, args.collection)
        if not collection_key:
            # Create collection if it doesn't exist
            resp = zot.create_collection([{'name': args.collection}])
            collection_key = resp['successful']['0']['data']['key']
        item['collections'] = [collection_key]

    resp = zot.create_items([item])
    created = resp['successful']['0']
    result = {'key': created['data']['key'], 'title': args.title, 'collection': args.collection}
    output(result, args.format)


def cmd_list(args):
    """List items in a collection."""
    zot = get_client()
    col_key = find_collection_key(zot, args.collection)
    if not col_key:
        print(f"Error: Collection '{args.collection}' not found", file=sys.stderr)
        sys.exit(1)
    items = zot.collection_items(col_key, limit=args.limit)
    results = [{
        'key': item['key'],
        'title': item['data'].get('title', ''),
        'creators': [c.get('lastName', c.get('name', '')) for c in item['data'].get('creators', [])],
        'date': item['data'].get('date', ''),
        'DOI': item['data'].get('DOI', ''),
        'extra': item['data'].get('extra', ''),
    } for item in items if item['data'].get('itemType') != 'attachment']
    output(results, args.format)


def cmd_add_to(args):
    """Add an existing item to a collection."""
    zot = get_client()
    col_key = find_collection_key(zot, args.collection)
    if not col_key:
        print(f"Error: Collection '{args.collection}' not found", file=sys.stderr)
        sys.exit(1)
    item = zot.item(args.item_key)
    collections = item['data'].get('collections', [])
    if col_key not in collections:
        collections.append(col_key)
        item['data']['collections'] = collections
        zot.update_item(item)
    result = {'key': args.item_key, 'collection': args.collection, 'action': 'added'}
    output(result, args.format)


def cmd_remove(args):
    """Remove an item from a collection."""
    zot = get_client()
    col_key = find_collection_key(zot, args.collection)
    if not col_key:
        print(f"Error: Collection '{args.collection}' not found", file=sys.stderr)
        sys.exit(1)
    item = zot.item(args.item_key)
    collections = item['data'].get('collections', [])
    if col_key in collections:
        collections.remove(col_key)
        item['data']['collections'] = collections
        zot.update_item(item)
    result = {'key': args.item_key, 'collection': args.collection, 'action': 'removed'}
    output(result, args.format)


def cmd_collections(args):
    """List all collections."""
    zot = get_client()
    cols = zot.collections()
    results = [{'key': c['key'], 'name': c['data']['name'], 'numItems': c['meta'].get('numItems', 0)} for c in cols]
    output(results, args.format)


def output(data, fmt):
    """Output data as JSON or text."""
    if fmt == 'text':
        if isinstance(data, list):
            for item in data:
                if 'title' in item:
                    creators = ', '.join(item.get('creators', []))
                    print(f"[{item['key']}] {item['title']} — {creators}")
                elif 'name' in item:
                    print(f"[{item['key']}] {item['name']} ({item.get('numItems', 0)} items)")
        elif isinstance(data, dict):
            for k, v in data.items():
                print(f"{k}: {v}")
    else:
        print(json.dumps(data, indent=2))


def main():
    parser = argparse.ArgumentParser(prog='zotero-cli', description='Zotero CLI for NanoClaw agents')
    parser.add_argument('--format', choices=['json', 'text'], default='json')
    sub = parser.add_subparsers(dest='command', required=True)

    # search
    p = sub.add_parser('search', help='Search library')
    p.add_argument('query')
    p.add_argument('--limit', type=int, default=10)
    p.set_defaults(func=cmd_search)

    # add
    p = sub.add_parser('add', help='Add item to library')
    p.add_argument('--title', required=True)
    p.add_argument('--authors', default='')
    p.add_argument('--doi', default='')
    p.add_argument('--url', default='')
    p.add_argument('--note', default='')
    p.add_argument('--type', default='journalArticle')
    p.add_argument('--collection', default='')
    p.set_defaults(func=cmd_add)

    # list
    p = sub.add_parser('list', help='List items in a collection')
    p.add_argument('collection')
    p.add_argument('--limit', type=int, default=25)
    p.set_defaults(func=cmd_list)

    # add-to
    p = sub.add_parser('add-to', help='Add item to a collection')
    p.add_argument('item_key')
    p.add_argument('collection')
    p.set_defaults(func=cmd_add_to)

    # remove
    p = sub.add_parser('remove', help='Remove item from a collection')
    p.add_argument('item_key')
    p.add_argument('collection')
    p.set_defaults(func=cmd_remove)

    # collections
    p = sub.add_parser('collections', help='List collections')
    p.set_defaults(func=cmd_collections)

    args = parser.parse_args()
    args.func(args)


if __name__ == '__main__':
    main()
```

Make executable: `chmod +x container/tools/zotero-cli/zotero_cli.py`

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /home/square/shoggoth/container/tools/zotero-cli && python -m pytest test_zotero_cli.py -v`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add container/tools/zotero-cli/
git commit -m "feat: add zotero-cli tool for Zotero Web API access"
```

---

### Task 2: Update Dockerfile to include Python and zotero-cli

**Files:**
- Modify: `container/Dockerfile`

- [ ] **Step 1: Add python3 and pip to apt-get install**

In `container/Dockerfile`, add `python3 python3-pip` to the existing `apt-get install` block (line 7-27), after `git`.

- [ ] **Step 2: Add pip install and CLI copy steps**

After the `npm install -g` line (line 34), add:

```dockerfile
# Install zotero-cli and its Python dependencies
COPY tools/zotero-cli/requirements.txt /opt/zotero-cli/requirements.txt
RUN pip install --break-system-packages -r /opt/zotero-cli/requirements.txt
COPY tools/zotero-cli/zotero_cli.py /usr/local/bin/zotero-cli
RUN chmod +x /usr/local/bin/zotero-cli
```

- [ ] **Step 3: Build the container to verify**

Run: `cd /home/square/shoggoth && ./container/build.sh`
Expected: Build succeeds, `zotero-cli --help` works inside container

- [ ] **Step 4: Verify zotero-cli is accessible in container**

Run: `docker run --rm --entrypoint zotero-cli nanoclaw-agent --help`
Expected: Shows usage help, exits 0

- [ ] **Step 5: Commit**

```bash
git add container/Dockerfile
git commit -m "feat: add python3 and zotero-cli to container image"
```

---

### Task 3: Inject Zotero env vars in container runner

**Files:**
- Modify: `src/container-runner.ts:242-255`

- [ ] **Step 1: Add ZOTERO vars to readEnvFile call**

In `src/container-runner.ts`, modify the `readEnvFile` call at line 243 to include Zotero keys. Change:

```typescript
  const contentRegistryEnv = readEnvFile([
    'OPENAI_API_KEY',
    'POSTGRES_PASSWORD',
  ]);
```

to:

```typescript
  const contentRegistryEnv = readEnvFile([
    'OPENAI_API_KEY',
    'POSTGRES_PASSWORD',
    'ZOTERO_API_KEY',
    'ZOTERO_LIBRARY_ID',
  ]);
```

- [ ] **Step 2: Add the -e flags for Zotero vars**

After the `NANOCLAW_PG_PASSWORD` block (after line 255), add:

```typescript
  if (contentRegistryEnv.ZOTERO_API_KEY) {
    args.push('-e', `ZOTERO_API_KEY=${contentRegistryEnv.ZOTERO_API_KEY}`);
  }
  if (contentRegistryEnv.ZOTERO_LIBRARY_ID) {
    args.push('-e', `ZOTERO_LIBRARY_ID=${contentRegistryEnv.ZOTERO_LIBRARY_ID}`);
  }
```

- [ ] **Step 3: Build to verify TypeScript compiles**

Run: `cd /home/square/shoggoth && npm run build`
Expected: Compiles without errors

- [ ] **Step 4: Commit**

```bash
git add src/container-runner.ts
git commit -m "feat: inject Zotero API credentials into agent containers"
```

---

### Task 4: Set up Zotero account and credentials

**Files:**
- Modify: `.env` (add ZOTERO_API_KEY and ZOTERO_LIBRARY_ID)

- [ ] **Step 1: Create Zotero account**

If the researcher doesn't have one: go to zotero.org and create an account.

- [ ] **Step 2: Generate API key**

Go to https://www.zotero.org/settings/keys/new — create a key with:
- Name: "NanoClaw"
- Personal Library: Allow read/write access

Note the API key and your library ID (shown at https://www.zotero.org/settings/keys — it's the numeric user ID).

- [ ] **Step 3: Create "To Read" collection**

Via the Zotero web library (zotero.org/[username]/library), create a collection called "To Read".

- [ ] **Step 4: Add credentials to .env**

Append to `.env`:

```
ZOTERO_API_KEY=<your-api-key>
ZOTERO_LIBRARY_ID=<your-library-id>
```

- [ ] **Step 5: Verify zotero-cli works end-to-end**

Run: `ZOTERO_API_KEY=<key> ZOTERO_LIBRARY_ID=<id> python3 container/tools/zotero-cli/zotero_cli.py collections`
Expected: JSON output showing the "To Read" collection

- [ ] **Step 6: Do NOT commit .env** — it contains secrets

---

### Task 5: Create reading-list skill

**Files:**
- Create: `container/skills/reading-list/SKILL.md`
- Create: `.claude/skills/shoggoth/reading-list.md`

- [ ] **Step 1: Write the container skill**

Create `container/skills/reading-list/SKILL.md`:

```markdown
---
name: reading-list
description: >
  Prioritized non-fiction reading list. Reads active projects and literature
  monitor output, manages Zotero "To Read" collection, produces a ranked
  vault note and WhatsApp summary. Runs twice weekly.
---

# Reading List

Produce a prioritized non-fiction reading list by combining Zotero queue, active project needs, and recent literature discoveries. Scheduled Monday and Thursday mornings; can also be triggered on demand.

## Process

1. **Read researcher context:**
   - `mcp__mcpvault__read_note` on `_meta/researcher-profile.md`, `_meta/top-of-mind.md`

2. **Read active project statuses:**
   - `mcp__mcpvault__list_directory` on `projects/`
   - `mcp__mcpvault__read_multiple_notes` on each project's `PROJECT.md`
   - Extract research needs, methods being used, and topics from `## Status` sections

3. **Check recent literature monitor output:**
   - `mcp__mcpvault__search_notes` in `literature/` for recent `weekly-*.md` files
   - Identify must-read and should-read papers not yet in Zotero

4. **Suggest additions to Zotero:**
   - For each paper from step 3 not already in Zotero, check via `zotero-cli search "<title>"` to avoid duplicates
   - Add new items via `zotero-cli add --title "..." --authors "..." --doi "..." --collection "To Read" --note "Relevant because: ..."`
   - The `--note` explains which project this supports and why it's timely

5. **Get current Zotero queue:**
   - Run `zotero-cli list "To Read"` to get all items in the collection

6. **Prioritize:**
   - Rank items by:
     - **Project relevance** (directly supports active work — highest weight)
     - **Urgency** (time-sensitive topics, fast-moving fields)
     - **Researcher signals** (mentioned in top-of-mind, flagged in conversation)
   - Group into tiers:
     - **Read Next** (3-5 items) — highest priority
     - **On Deck** (5-10 items) — important but not urgent
     - **Backlog** (remainder) — worth reading eventually

7. **Write vault note** — `mcp__mcpvault__write_note` to `literature/reading-list.md`:

   ```yaml
   ---
   generated: 'YYYY-MM-DD'
   total_items: <N>
   new_additions: <N>
   ---
   ```

   Body:
   - `# Reading List — YYYY-MM-DD`
   - `## Read Next` — each item with a 1-sentence note on why it matters *now*
   - `## On Deck` — items with brief relevance notes
   - `## Backlog` — titles and authors only

8. **Send WhatsApp summary** — `mcp__nanoclaw__send_message`:
   - Top 3 "Read Next" items with why
   - Number of new additions since last run
   - Flag any items that have been in "To Read" for over 4 weeks

## Error handling

If `zotero-cli` commands fail (API key expired, network issues, Zotero outage):
- Still produce the vault note using whatever data is available (vault-only sources, cached information)
- Note in the vault file and WhatsApp message that Zotero was unreachable
- Do not abort the entire skill run

## Quality bar

- Every "Read Next" item must have a specific reason tied to active work, not a generic "relevant to your field"
- Don't inflate tiers — if only 1 item is urgent, the Read Next section has 1 item
- Items sitting in the queue for 4+ weeks should be called out (stale queue warning)
- New additions must be genuinely relevant, not padded to look productive

## What not to do

- Don't add fiction or non-research items to Zotero
- Don't remove items from Zotero without the researcher's confirmation
- Don't duplicate items already in Zotero (always search before adding)
- Don't generate a reading list if the Zotero queue is empty and there are no new papers — just report "nothing new"
```

- [ ] **Step 2: Copy as host-side mirror**

Copy the identical content to `.claude/skills/shoggoth/reading-list.md`.

- [ ] **Step 3: Commit**

```bash
git add container/skills/reading-list/SKILL.md .claude/skills/shoggoth/reading-list.md
git commit -m "feat: add reading-list skill for prioritized non-fiction queue"
```

---

### Task 6: Update literature-monitoring skill

**Files:**
- Modify: `container/skills/literature-monitoring/SKILL.md`
- Modify: `.claude/skills/shoggoth/literature-monitoring.md`

- [ ] **Step 1: Add Zotero step to container skill**

In `container/skills/literature-monitoring/SKILL.md`, insert a new step between the existing step 5 ("Update the reading queue") and step 6 ("Report back"). The existing step 6 becomes step 7.

After line 47 (end of step 5), insert:

```markdown

6. **Add must-read papers to Zotero** — for each Must-Read paper:
   - Check if already in Zotero via `zotero-cli search "<title>"` (avoid duplicates)
   - If not present, call `zotero-cli add --title "..." --authors "..." --doi "..." --collection "To Read" --note "<relevance note from step 4>"` with the same relevance explanation written in the weekly report
   - If `zotero-cli` fails (network, auth), skip this step and note the failure — do not abort the rest of the skill
```

Renumber the existing `6. **Report back**` (line 49) to `7. **Report back**`.

**Important:** The existing step 5 (appending to `queue.md`) is preserved for backwards compatibility. It can be removed once the reading-list skill is validated as working.

- [ ] **Step 2: Apply same changes to host-side mirror**

Make the identical edit to `.claude/skills/shoggoth/literature-monitoring.md`.

- [ ] **Step 3: Commit**

```bash
git add container/skills/literature-monitoring/SKILL.md .claude/skills/shoggoth/literature-monitoring.md
git commit -m "feat: literature monitor pushes must-read papers to Zotero"
```

---

### Task 7: Update global CLAUDE.md with reading-list skill

**Files:**
- Modify: `groups/global/CLAUDE.md`

- [ ] **Step 1: Add reading-list to the skills table**

In `groups/global/CLAUDE.md`, add a new row to the skill trigger table (after the literature-monitoring row, around line 37):

```markdown
| Twice-weekly (scheduled) or "what should I read?", "reading list" | `/reading-list` | Prioritizes Zotero "To Read" queue against active projects, writes ranked vault note |
```

- [ ] **Step 2: Commit**

```bash
git add groups/global/CLAUDE.md
git commit -m "feat: add reading-list skill to agent capabilities"
```

---

### Task 8: Register scheduled tasks

**Files:** None (operational — uses NanoClaw task scheduling)

- [ ] **Step 1: Schedule Monday reading list run**

Via a message to the agent or directly using the NanoClaw scheduler, create a recurring task:
- Name: `reading-list-mon`
- Cron: `0 8 * * 1` (Monday 08:00)
- Timezone: `Europe/Zurich`
- Skill: `/reading-list`

If using `mcp__nanoclaw__schedule_task`:
```
schedule_task({name: "reading-list-mon", cron: "0 8 * * 1", timezone: "Europe/Zurich", prompt: "/reading-list"})
```

- [ ] **Step 2: Schedule Thursday reading list run**

```
schedule_task({name: "reading-list-thu", cron: "0 8 * * 4", timezone: "Europe/Zurich", prompt: "/reading-list"})
```

- [ ] **Step 3: Verify schedules**

Run: `mcp__nanoclaw__list_tasks` or check `data/ipc/*/current_tasks.json`
Expected: Both `reading-list-mon` and `reading-list-thu` appear with correct cron expressions

---

### Task 9: Rebuild container and end-to-end test

**Files:** None (verification only)

- [ ] **Step 1: Rebuild container image**

Run: `cd /home/square/shoggoth && ./container/build.sh`
Expected: Build succeeds with python3, pyzotero, and zotero-cli included

- [ ] **Step 2: Verify zotero-cli in container**

Run: `docker run --rm -e ZOTERO_API_KEY=test -e ZOTERO_LIBRARY_ID=test nanoclaw-agent zotero-cli collections --format text`
Expected: Either shows collections or shows a clear API error (not a "command not found" error)

- [ ] **Step 3: Verify skills are mounted**

Run: `docker run --rm nanoclaw-agent ls /app/`
Check that the build completes. Skills are mounted at runtime by the container runner (not baked into the image), so verify via a NanoClaw test run if possible.

- [ ] **Step 4: Run NanoClaw build**

Run: `cd /home/square/shoggoth && npm run build`
Expected: Compiles without errors

---

### Task 10: Migrate existing queue.md to Zotero (one-time)

**Files:** None (operational task)

- [ ] **Step 1: Read current queue.md**

Read the vault's `literature/queue.md` to understand what items are there.

- [ ] **Step 2: Add items to Zotero**

For each item in `queue.md`, run:
```bash
zotero-cli add --title "<title>" --authors "<authors>" --doi "<doi if available>" --collection "To Read" --note "Migrated from queue.md"
```

Items lacking structured metadata (DOI, authors) should be added with title only and `--note "Migrated from queue.md — needs metadata enrichment"`.

- [ ] **Step 3: Verify migration**

Run: `zotero-cli list "To Read" --format text`
Expected: All items from queue.md appear in the collection

- [ ] **Step 4: Note in queue.md that it's superseded**

Append to `literature/queue.md`:
```
---
**Note:** This file is superseded by the Zotero "To Read" collection and `literature/reading-list.md`. New items go to Zotero via the reading-list and literature-monitoring skills.
```
