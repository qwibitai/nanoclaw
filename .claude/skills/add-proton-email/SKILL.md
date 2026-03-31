---
name: add-proton-email
description: "Install Proton Mail email skill for NanoClaw container agents. Adds email commands, approval gates, templates, and audit logging on top of existing Proton MCP tools."
---

# Add Proton Email Skill

Installs email capabilities for the container agent using the existing `mcp__proton__mail__*` MCP tools. No new host-side code needed.

## Phase 1: Pre-flight

Check if already applied:

```bash
grep -c "## Email Skill" /workspace/group/CLAUDE.md
```

If found, report "Email skill already installed" and stop.

Verify Proton MCP is mounted by checking if `mcp__proton__mail__list_messages` is available. If not, report that the Proton MCP server needs to be configured first.

## Phase 2: Apply CLAUDE.md Addition

Read the contents of this skill's `CLAUDE-addition.md` file and append it to `/workspace/group/CLAUDE.md`.

## Phase 3: Create Templates

Create the directory `/workspace/group/email-templates/` and write all default template files from this skill's `templates/` directory.

## Phase 4: Create Audit Log

```bash
mkdir -p /workspace/group/logs
touch /workspace/group/logs/mail-audit.jsonl
```

## Phase 5: Verify and Summarize

- Confirm CLAUDE.md contains "## Email Skill"
- Confirm email-templates/ directory exists with template files
- Confirm logs/mail-audit.jsonl exists and is writable
- Report installed commands to user:
  - `email draft` — compose and show for approval
  - `email reply --id <n>` — fetch thread, compose reply
  - `email follow-up --to <addr> --days 5` — check if replied, draft nudge
  - `email check` — summarize unread by priority
  - `email send-template --name <t> --to <addr> --vars "k=v,..."` — fill template
