# Quickstart: Obsidian Journal Audio Linking

## Prerequisites

- NanoClaw running with Telegram channel configured
- Obsidian vault at `~/Obsidian/pj-private-vault/pj-private-vault/`
- whisper.cpp installed with `ggml-large-v3.bin` model
- qmd installed and indexed for `pj-private-vault` (optional — degrades gracefully)

## What Changes

### Host-side (`src/`)

1. **`src/obsidian.ts`** — `saveAudioToVault()` accepts a `Date` parameter and names files `YYYY-MM-DD-HHMMSS.ogg` instead of `voice-{id}.ogg`.

2. **`src/transcription.ts`** — `transcribeBuffer()` accepts an optional `messageTimestamp: Date` parameter and passes it to `saveAudioToVault()`.

3. **`src/channels/telegram.ts`** — Voice message handler passes `new Date(ctx.message.date * 1000)` as the message timestamp to `transcribeBuffer()`.

4. **`src/index.ts`** — No structural changes needed. The `/obsidian` command path remains for explicit note creation. Journal intent detection is handled by the container agent.

### Container-side (`container/skills/`)

5. **`container/skills/obsidian-notes/SKILL.md`** — Updated to document:
   - `Journal/` folder convention for daily notes
   - `### HH:MM` entry format with audio embeds
   - Journal intent detection (NLU-based, no `/obsidian` required)
   - Phrase stripping rules
   - Audio embed placement

### Tests (`src/`)

6. **`src/obsidian.test.ts`** — New test file covering:
   - Timestamp-based audio filename generation
   - Journal entry formatting (with/without audio)
   - Date extraction from message timestamps

## Build & Test

```bash
# Run tests
npm test

# Type check
npm run typecheck

# Build
npm run build

# Rebuild container (after skill changes)
rm -rf data/sessions/*/agent-runner-src/  # Clear stale copies
./container/build.sh
```

## Verification

1. Send a text message via Telegram: "add to the daily journal: Testing the new journal feature"
2. Verify `~/Obsidian/pj-private-vault/pj-private-vault/Journal/YYYY-MM-DD.md` is created
3. Verify the entry has `### HH:MM` heading and cleaned content (trigger phrase stripped)

4. Send a voice message via Telegram saying "add this to the daily journal, here are my thoughts on the API migration"
5. Verify the daily note has a new entry with:
   - `### HH:MM` heading
   - Cleaned transcription
   - `![[YYYY-MM-DD-HHMMSS.ogg]]` audio embed
   - `[[API Migration]]` wikilink (if that note exists in the vault)

6. Send a text message via Telegram without the trigger phrase: "what's the weather like?"
7. Verify NO journal entry is created

8. Verify `attachments/audio/YYYY-MM-DD-HHMMSS.ogg` exists and is playable
