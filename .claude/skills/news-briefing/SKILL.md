---
name: news-briefing
description: Add a daily AI-powered news briefing to a NanoClaw group. Researches news across configurable topics using parallel agents, compiles results into a professional PDF, and delivers it via WhatsApp on a schedule.
---

# News Briefing Skill

This skill deploys a daily news briefing system into a NanoClaw group. Each morning (or on demand), the agent researches news across user-defined categories, compiles unique articles with deduplication, generates a styled PDF, and delivers it to the group's WhatsApp chat.

**Requires:** `send_file` capability (install the `add-file-sending` skill first if not already applied).

## Phase 1: Pre-flight

### Check dependencies

Verify the `add-file-sending` skill has been applied. Check `.nanoclaw/state.yaml` for `add-file-sending` in `applied_skills`. If missing, tell the user to run `/add-file-sending` first and stop.

### Ask the user

Use `AskUserQuestion` to collect:

1. Which group should receive the briefings? (list registered groups from `data/registered_groups.json`)
2. What time should the daily briefing be delivered? (default: 07:00)

## Phase 2: Deploy Skill Files

Copy the skill's Python source into the target group's folder.

### Create directories

```bash
GROUP_FOLDER=<folder-name-from-registered-groups>
mkdir -p groups/$GROUP_FOLDER/nanoclaw-skills/news-briefing/src
mkdir -p groups/$GROUP_FOLDER/nanoclaw-skills/news-briefing/config
mkdir -p groups/$GROUP_FOLDER/nanoclaw-skills/news-briefing/templates
mkdir -p groups/$GROUP_FOLDER/nanoclaw-skills/news-briefing/reports
mkdir -p groups/$GROUP_FOLDER/nanoclaw-skills/news-briefing/memory
mkdir -p groups/$GROUP_FOLDER/nanoclaw-skills/news-briefing/agents/results
```

### Copy skill files

Copy the following files from `.claude/skills/news-briefing/` to `groups/$GROUP_FOLDER/nanoclaw-skills/news-briefing/`:

- `skill.py` → root
- `src/orchestrator.py` → `src/`
- `src/compile_briefing.py` → `src/`
- `src/generate_pdf.py` → `src/`
- `src/main.py` → `src/`
- `src/research_coordinator.py` → `src/`
- `src/setup_scheduler.py` → `src/`
- `src/topic_manager.py` → `src/`
- `templates/briefing_template.html` → `templates/`

```bash
cp .claude/skills/news-briefing/skill.py groups/$GROUP_FOLDER/nanoclaw-skills/news-briefing/
cp .claude/skills/news-briefing/src/*.py groups/$GROUP_FOLDER/nanoclaw-skills/news-briefing/src/
cp .claude/skills/news-briefing/templates/briefing_template.html groups/$GROUP_FOLDER/nanoclaw-skills/news-briefing/templates/
```

### Write default config

Write `groups/$GROUP_FOLDER/nanoclaw-skills/news-briefing/config/user_preferences.json` with the content from `.claude/skills/news-briefing/config/user_preferences.json`.

## Phase 3: Configure

### Get the group's chat JID

Read `data/registered_groups.json` and find the JID for the selected group.

### Update paths in main.py

Edit `groups/$GROUP_FOLDER/nanoclaw-skills/news-briefing/src/main.py`:

1. Replace the `groupFolder` value in the IPC message with the actual group folder name.
2. Replace the placeholder `YOUR_CHAT_JID_HERE` in the `chatJid` field with the group's actual JID from `registered_groups.json`.

### Set delivery time

If the user requested a non-default delivery time, update `delivery_time` in `config/user_preferences.json`.

### Update CLAUDE.md

Append the following to `groups/$GROUP_FOLDER/CLAUDE.md`:

```markdown
## News Briefing Skill

You have a daily news briefing system available at `/workspace/group/nanoclaw-skills/news-briefing/`.

### Commands

- `/news-briefing generate` — Generate and deliver a briefing immediately
- `/news-briefing schedule [HH:MM]` — Schedule daily automated briefings
- `/news-briefing topics list` — List all tracked topics
- `/news-briefing topics add <category> "<topic>"` — Add a topic
- `/news-briefing topics remove "<topic>"` — Remove a topic
- `/news-briefing status` — Show last briefing info and memory stats
- `/news-briefing clear-memory` — Reset seen articles (for testing)

### Running the skill

When a user asks for `/news-briefing <command>`, run:

```bash
python3 /workspace/group/nanoclaw-skills/news-briefing/skill.py <command> [args]
```

Categories: `world_highlights`, `technology`, `economy_finance`, `custom_tracking`
```

## Phase 4: Verify

Tell the user:

> The news briefing skill has been deployed to the **{group}** group.
>
> To generate your first briefing, send `/news-briefing generate` in that chat — it takes about 60 seconds and will deliver a PDF with today's top stories.
>
> To schedule daily briefings, send `/news-briefing schedule 07:00` (or your preferred time).
>
> **Customize your topics:** `/news-briefing topics add custom_tracking "your topic"`

## Troubleshooting

### "send_file not available"

The `add-file-sending` skill is required. Run `/add-file-sending` first.

### "0 articles in briefing"

All articles were seen before. Run `/news-briefing clear-memory` to reset.

### PDF not delivered

Check that WhatsApp is connected and the group JID in `src/main.py` matches `registered_groups.json`.

### Agents timeout

WebSearch can be slow. Wait a few minutes and try again.
