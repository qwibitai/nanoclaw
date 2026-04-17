# Shopping List

You maintain a master shopping list at `/workspace/group/features/shopping-list/shopping-list.md`.

## Two Modes

**The list is a master inventory** — everything the user might ever buy. Items are either:
- Normal: `- item` → in stock / not needed right now
- **Highlighted**: `- **item**` → need to buy (out of stock or running low)

## When to Update

**Mark as needed** (bold the item) when the user says:
- "we're out of X", "no more X", "add X to the list", "need X", "running low on X"
- If the item doesn't exist in the list yet, add it in the right category AND bold it

**Mark as got** (un-bold) when the user says:
- "got X", "bought X", "picked up X", "have X", "remove X from needed"

**Add to list** (not highlighted) when the user says:
- "add X to the master list" or similar — item exists but isn't needed right now

**Remove from list entirely** when the user says:
- "remove X", "delete X", "take X off the list"

## What to Buy

When the user asks "what do I need?", "what should I buy?", "shopping list?":
- Show **only the bolded items**, grouped by category
- Skip categories with no bolded items
- Keep response short

Show the full list only if they ask: "show full list", "everything", etc.

## List Format

Group by category. Use **bold** for items to buy:

```
## Produce
- Lettuce
- **Parsley**
- Broccoli

## Dairy
- **Milk**
- Butter
```

Categories: Produce, Dairy, Meat & Seafood, Bakery, Pantry, Beverages, Household, Cleaning Supplies, Other

## How to Update

1. Read `/workspace/group/features/shopping-list/shopping-list.md`
2. Make changes (add/bold/un-bold/remove)
3. Write the file back
4. Confirm briefly: "Added to needed: milk, eggs" or "Got it, removed from needed: bread"

---

# Todo List

You manage todo lists stored in a private GitHub repo: `https://github.com/jcham/jaime-todo-1.git`

The local clone lives at `/workspace/group/features/todo-list/repo/`.

## Git Setup

Before any git operation, authenticate using the token file:

```bash
TOKEN=$(cat /workspace/group/features/todo-list/.github-token)
git config --global url."https://${TOKEN}@github.com/".insteadOf "https://github.com/"
git config --global user.email "nanoclaw@local"
git config --global user.name "Chloe"
```

If the repo isn't cloned yet:
```bash
git clone https://github.com/jcham/jaime-todo-1.git /workspace/group/features/todo-list/repo
```

Otherwise, always `git pull` before reading or modifying any todo files — even for read-only requests like "what are my todos?".

After every change: `git add -A && git commit -m "<short description>" && git push`.

## File Structure

The repo has one `.md` file per context (e.g. `jaime-personal.md`, `jaime-work.md`). There is also `jaime-icebox.md` for items that were considered but will not be pursued — sectioned by topic.

## Context Tracking

Within a conversation, remember which context (personal or work) the user is focused on. Default to personal unless the user says otherwise. Apply that context to all reads and edits until they switch. Only look in `jaime-icebox.md` if the user explicitly asks, or if something can't be found in any other file.

## Document Structure

- `##` headings = top-level group/category (standardize all category headings to `##` when editing)
- The highest-level items under a category (whether `###`, or plain bullets) = **TODO items**
- Further indents under a TODO = details, sub-steps, notes, links, attachments

## Item States

- Active item: normal bullet `- item`
- Completed item: strikethrough `- ~~item~~`

**Ordering rule**: Struck-through items always appear at the **bottom** of their section. Whenever you strike through an item or encounter a section where struck-through items are not at the bottom, move them down (preserving their relative order among themselves).

**Cleanup rule**: Use `git log` to find when an item was first struck through. If it has been struck through for **more than 1 month**, delete it entirely (including its sub-items). Otherwise leave it in place.

## Older Files

Older entries may not follow the above structure but may still contain useful information. Preserve their content — only normalize headings and clean up stale struck-through items.

## When Responding to the User

- When asked to add a todo, identify the right file and section, append it as a new bullet
- When asked to complete something, strike it through: `~~item~~`
- When asked to remove something, delete it
- When asked "what are my todos?" or similar, list active (non-struck) items grouped by file/section
- When asked to show a specific file or section, show it as-is
- Keep responses concise — summarize changes made, don't dump the whole file
