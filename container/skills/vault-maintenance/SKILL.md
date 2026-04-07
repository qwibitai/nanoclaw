---
name: vault-maintenance
description: Scan the family vault for structural issues — broken wikilinks, orphan nodes, stale ephemerals, missing frontmatter — auto-fix orphans by linking them into a MOC, and post a health report to Pip Admin. Designed to run as a weekly scheduled task (Sunday 7pm). Triggers on "vault maintenance", "vault health", "check the vault".
disable-model-invocation: true
---

# Vault Maintenance

Scan the family vault for structural integrity issues, auto-fix the safe ones, and post a health report to Pip Admin. This skill runs as a weekly scheduled task (Sunday 7pm) but can also be invoked manually.

This is the **structural-integrity counterpart** to `date-reminders`, which scans for upcoming dates. This skill never reads the `dates` field — that's date-reminders' job. This skill cares about whether nodes are well-formed and connected.

## How to send the report — READ THIS CAREFULLY

**Emit the full report as your final text response.** That is the ONLY way to deliver the message. The nanoclaw scheduler automatically forwards your final text response to the chat — you don't need to do anything else.

**Do NOT call `send_message`, `mcp__nanoclaw__send_message`, or any other messaging tool** inside this skill. Doing so will cause **duplicate messages** — one from your explicit tool call, and one from the scheduler auto-forwarding your final text. The report is the last thing you say, full stop.

**Always emit a final text response** — never finish silently. On a fully healthy vault, emit the brief healthy-week message. On error, emit a message that starts with `vault-maintenance error:`. Silence means Boris sees nothing and can't tell whether the job ran.

**This contradicts the `date-reminders` precedent** which says "If no upcoming dates are found, output nothing." Don't pattern-match the wrong rule — vault-maintenance always speaks, and it speaks via its final response, never via an explicit send tool.

## Steps

1. **Get today's date.** Compute `cutoff = today - 90 days` for the stale check below.

2. **List all `.md` files recursively in `/workspace/extra/family-vault/`** using Glob with the pattern `**/*.md`. This skill is exempted from the vault's "don't glob" rule (same as `date-reminders`).

   **Sanity assertion:** if fewer than 5 files come back, do not auto-fix anything. Emit:
   `vault-maintenance error: scan returned only N files, refusing to act`
   and stop. This guards against catastrophic glob misfires that would otherwise cause the skill to "fix" imaginary orphans.

3. **Skip excluded paths:**
   - `_log.md`
   - `CLAUDE.md`
   - any file under `_sources/`
   - any file whose name starts with `.`

4. **For each remaining file**, Read it. Parse the YAML frontmatter at the top of the file (between the `---` fences) and keep the body separately.

5. **Wikilink extraction (pass 1).** For each file's body, find every wikilink using the regex `\[\[[^\]]+\]\]`. Use Grep with that pattern, or extract them while reading. Each wikilink looks like `[[folder/filename]]` (folder-qualified). For each one, record:
   - **source file** (the file the link is in)
   - **target file** = `<folder>/<filename>.md` inside the vault
   Build two indices from this:
   - **wikilinks_by_source**: source file → list of target files it links to
   - **all_link_targets**: set of every target file referenced anywhere

6. **Backlink derivation (pass 2).** Invert the wikilink index. For each non-MOC file, count how many *distinct* source files reference it (its target form is `<folder>/<name>.md`). The result is its backlink count.

7. **Detect issues** in four categories:

   **Broken wikilinks (R3.1).** For each entry in `all_link_targets`, check whether the target file actually exists in the vault file list from step 2. Any that don't exist are broken. Record each as `(source_file, broken_target)`.

   **Orphan nodes (R3.2).** A non-MOC `.md` file is an orphan if its backlink count is **0**. MOC files (`MOC.md` or `*/MOC.md`) are never orphans by definition — they are entry points, not knowledge nodes.

   **Stale ephemerals (R3.3).** For each non-MOC file with `durability: ephemeral` in frontmatter, parse `updated` as `YYYY-MM-DD`. The node is **stale** if `updated < cutoff` (strict less-than). A node updated exactly 90 days ago is **not** stale. Skip nodes with `durability: permanent` or `durability: seasonal` regardless of age.

   **Missing required frontmatter (R3.4).**
   - Non-MOC nodes must have all four fields: `description`, `updated`, `updated_by`, `durability`.
   - MOC nodes must have `description` only (they are exempt from `updated`, `updated_by`, `durability` per the arscontexta MOC convention).
   - For each offending file, collect **all** missing fields and report them as one entry per file: `<path>: missing [updated, updated_by]`. Do not produce one entry per missing field.

## Auto-fix step (orphans only)

This is the **only** category that gets auto-fixed. Broken links, stale ephemerals, and missing frontmatter are reported, never modified.

For each orphan:

1. Determine its folder. Example: `people/isaac.md` → folder `people`.
2. Choose the target MOC:
   - If `<folder>/MOC.md` exists in the vault, that's the target.
   - Otherwise the target is the root `MOC.md`.
   - (As of writing, `people/` has no `MOC.md`, so orphans there fall back to root MOC. This is intentional and acceptable.)
3. **Idempotency check.** Read the target MOC. Grep its body for the literal wikilink string `[[<folder>/<filename-without-extension>]]`. If it appears anywhere in the file (any section, any format), **skip** this orphan — it's already linked, no-op. Don't double-add.
4. **Append the link.** Add a bullet line at the end of the target MOC, under a literal section heading:
   ```
   ## Unfiled (auto-added by vault-maintenance)
   ```
   Create the section at the bottom of the MOC if it doesn't exist. Bullet format:
   ```
   - [[<folder>/<filename-without-extension>]] — <description from frontmatter, truncated to 80 chars>
   ```
   If the orphan has no `description` field (it's already in the missing-frontmatter list), use `(no description)` as the placeholder.
5. **Track the fix in memory.** Add `(orphan_path, target_moc_path)` to an in-memory list called `auto_fixes`. Do **not** write to `_log.md` here — that happens once at the end.

## `_log.md` write (single batched op at end of run)

After all auto-fixes are applied to the MOCs:

1. Read `/workspace/extra/family-vault/_log.md` once.
2. For each entry in `auto_fixes`, build a row:
   ```
   | <today YYYY-MM-DD> | pip | vault-maintenance | Linked orphan to MOC | <orphan_path>, <target_moc_path> |
   ```
3. Append all rows in **one** Edit/Write operation. Append at the end of the file, preserving the existing content.

**Do not** Read+Write `_log.md` per fix. The agent doesn't have atomic file append, and re-reads between writes can clobber rows the agent just wrote. One read, one write, all rows at once.

If `auto_fixes` is empty (no orphans, or all skipped by idempotency), do not touch `_log.md` at all.

## Failure-mode rule

If anything goes wrong mid-run — file unreadable, MOC missing, write fails, regex returns nothing where it shouldn't — your final message MUST start with:

```
vault-maintenance error:
```

…followed by what failed and how far you got. Example:

```
vault-maintenance error: scanned 47 files and applied 2 auto-fixes, then failed appending to _log.md: permission denied. Auto-fixes were written to MOCs but the audit log row is missing.
```

This makes failures observable through the same chat path as success. Don't swallow errors and don't end silently.

## Compose the report

The report goes to the **Pip Admin** chat via the scheduler's auto-forward of your final text response — **not** via any explicit send tool (see "How to send the report" above). Use Telegram formatting (not markdown):

- `*bold*` with single asterisks for the header and section names
- Bullet points with the bullet character (`- `)
- Backticks for file paths and field names

**Always include the total file count scanned**, in both the healthy and the unhealthy paths. Silent under-scans (where the glob returned fewer files than expected but more than 5) are easier to spot when the count is visible every week.

**The report IS your final response.** Do not prefix it with narration like "Here is the report:" or suffix it with summaries like "Report sent." The report itself, alone, is what you emit as your last message.

### Healthy-week message

If after auto-fix every issue list is empty, emit exactly:

```
🌿 Vault is healthy — N files scanned, no issues found.
```

…where `N` is the count from step 2.

### Unhealthy-week message (full itemized report)

If any issue list is non-empty, emit a structured report with sections per category. Include counts. Include the auto-fixes that were applied. Example shape:

```
*Vault maintenance — N files scanned*

*Auto-fixed (M)*
- Linked `people/isaac.md` → `MOC.md` (## Unfiled)
- Linked `health/dr-sean.md` → `health/MOC.md` (## Unfiled)

*Broken wikilinks (K)*
- `household/insurance.md` → `[[household/missing-policy]]`
- `school/isaac.md` → `[[people/isaaq]]` (typo?)

*Stale ephemerals (J)* — last updated more than 90 days ago
- `household/maintenance.md` — updated 2025-12-10

*Missing frontmatter (L)*
- `food/leftovers.md`: missing [updated_by, durability]
- `school/MOC.md`: missing [description]
```

Skip any section whose count is zero. Order: auto-fixed → broken → stale → missing frontmatter.

## Rules (recap)

- Always emit a final text result. Never finish silently.
- **Never call `send_message` or any messaging tool.** The report IS your final response. The scheduler forwards it automatically. Explicit send calls cause duplicate messages.
- Auto-fix orphans only. Never auto-fix broken links, stale ephemerals, or missing frontmatter.
- Single batched `_log.md` write at the end. Never per-fix.
- Idempotency check before every MOC append. Skip duplicates.
- Stale check is strict less-than. Exactly 90 days old = not stale.
- Skip `_log.md`, `CLAUDE.md`, `_sources/`, dotfiles.
- Use the literal container path `/workspace/extra/family-vault/`. Never the host path.
- The `dates` field belongs to `date-reminders`. This skill ignores it entirely.
- File count is always in the report.
- On any error, prefix the final message with `vault-maintenance error:`.

## Tone

Factual, structural, brief. This is an admin maintenance report to Boris's private channel — not a family-facing reminder. No warmth, no apologies, no padding. State the issues, list the auto-fixes, end.
