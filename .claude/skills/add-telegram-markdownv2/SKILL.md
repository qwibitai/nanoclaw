---
name: add-telegram-markdownv2
description: Add MarkdownV2 formatting to Telegram outgoing messages so bold, italic, and code actually render instead of showing raw asterisks and underscores.
---

# Add Telegram MarkdownV2 Formatting

Without `parse_mode`, Telegram renders all bot messages as plain text — `*bold*` shows up as literal asterisks. This skill adds MarkdownV2 support with a plain-text fallback so messages always get delivered.

> **Note to maintainers:** This arguably belongs in the base `/add-telegram` skill since it affects all Telegram users — without it, no formatting renders at all. Submitted as a separate skill to respect the contribution guidelines. Happy to help fold it into the base skill if that's preferred.

## Prerequisites

The `/add-telegram` skill must be applied first. This skill modifies the Telegram channel file it creates.

## Phase 1: Pre-flight

### Check prerequisites

1. Read `.nanoclaw/state.yaml`. Verify `telegram` is in `applied_skills`. If not, tell the user to run `/add-telegram` first and stop.
2. If `telegram-markdownv2` is already in `applied_skills`, tell the user it's already applied and stop.

## Phase 2: Apply Code Changes

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-telegram-markdownv2
```

This modifies `src/channels/telegram.ts` to:
- Add `toMarkdownV2()` — escapes MarkdownV2 special characters while preserving `*bold*`, `_italic_`, `` `code` ``, and ` ```code blocks``` `
- Add `sendFormattedMessage()` — sends with `parse_mode: MarkdownV2`, falls back to plain text if Telegram rejects the markup
- Add `sendChunked()` — handles 4096-char splitting with formatting
- Update `TelegramChannel.sendMessage()` to use the new helpers

### Validate

```bash
npm test
npm run build
```

All tests must pass and build must be clean.

## Phase 3: Restart

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Verify

Send a message to the bot that includes `*bold*` or `_italic_` text. It should render with actual formatting in Telegram instead of showing raw asterisks/underscores.

## How It Works

- Outgoing messages are escaped for MarkdownV2 (special characters like `.`, `!`, `(`, `)` get backslash-escaped)
- Formatting characters the agent uses (`*`, `_`, `` ` ``) are passed through as-is
- If MarkdownV2 parsing fails (e.g. unbalanced formatting), the message is retried as plain text — it always gets delivered

## Removal

To remove MarkdownV2 formatting, re-apply the base `/add-telegram` skill to restore the original `telegram.ts`, then rebuild:

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-telegram
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
```
