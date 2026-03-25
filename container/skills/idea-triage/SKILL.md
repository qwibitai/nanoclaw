---
name: idea-triage
description: >
  Archive or upgrade an explored idea. Archiving moves it to ideas/archive/.
  Upgrading creates a project folder in the vault and a private GitHub repo.
---

# Idea Triage

Move an idea to its final destination: archive (not viable or not timely) or upgrade to a full project.

## Trigger

Manual. Researcher says something like:
- "archive [[slug]]"
- "upgrade [[slug]] to project"
- "this one's not going anywhere, archive it"
- "let's turn this into a project"

## Archive path

1. **Move the note** — `mcp__mcpvault__move_note` from `ideas/YYYY-MM-DD-slug.md` to `ideas/archive/YYYY-MM-DD-slug.md`

2. **Update frontmatter** — `mcp__mcpvault__update_frontmatter` on the moved note: `status: archived`

3. **Remove from scratch** — `mcp__mcpvault__patch_note` on `ideas/scratch.md` to remove the line containing `[[YYYY-MM-DD-slug]]`

4. **Confirm** — "Archived [[slug]]. It's in ideas/archive/ if you need it later."

## Upgrade path

1. **Read the idea note** — `mcp__mcpvault__read_note` on `ideas/YYYY-MM-DD-slug.md` to get the exploration findings for seeding the project.

2. **Create PROJECT.md** — `mcp__mcpvault__write_note` to `projects/{slug}/PROJECT.md`:

   ```yaml
   ---
   phase: research
   priority: medium
   last_updated: YYYY-MM-DD
   ---
   ```

   Sections seeded from the idea's exploration findings:
   - `# {Project Title}` — derived from the idea, not the slug
   - `## Status` — "Promoted from idea exploration on YYYY-MM-DD. [Summary of where things stand based on What we found / What to do next]"
   - `## Context` — Key findings from exploration: literature landscape, feasibility notes, methodological approach
   - `## Key Decisions` — "YYYY-MM-DD — Promoted from idea to project based on [researcher's reasoning if stated]"

   The slug for the project folder drops the date prefix from the idea slug (e.g., `ideas/2026-03-25-adversarial-deliberation.md` becomes `projects/adversarial-deliberation/`).

3. **Move idea note as ORIGIN.md** — `mcp__mcpvault__move_note` from `ideas/YYYY-MM-DD-slug.md` to `projects/{slug}/ORIGIN.md`

4. **Update frontmatter** — `mcp__mcpvault__update_frontmatter` on ORIGIN.md: `status: upgraded`

5. **Create GitHub repo** — via Bash:

   ```bash
   gh repo create {slug} --private --template cmhenry/research-project-template
   ```

   If the template repo doesn't exist yet, create a plain private repo instead:

   ```bash
   gh repo create {slug} --private
   ```

   Then report that the template repo needs to be set up.

6. **Remove from scratch** — `mcp__mcpvault__patch_note` on `ideas/scratch.md` to remove the line containing the idea's backlink.

7. **Confirm** — "Upgraded [[slug]] to project. Vault: projects/{slug}/, Repo: github.com/cmhenry/{slug}"

## What not to do

- Don't archive or upgrade without explicit researcher instruction
- Don't lose the original idea prose — it's preserved as ORIGIN.md
- Don't set project priority to high by default — let the researcher adjust
- Don't create extra directories in the repo — just the template skeleton
