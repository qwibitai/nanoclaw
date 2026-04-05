---
name: add-wiki
description: Add a persistent wiki knowledge base to a NanoClaw group. Based on Karpathy's LLM Wiki pattern. Triggers on "add wiki", "wiki", "knowledge base", "llm wiki".
---

# Add Wiki

Set up a persistent wiki knowledge base on NanoClaw, based on Karpathy's LLM Wiki pattern.

## Step 1: Read the pattern

Read `${CLAUDE_SKILL_DIR}/llm-wiki.md` — this is the full LLM Wiki idea as written by Karpathy. Understand it thoroughly before proceeding. Summarize the core idea to the user briefly, then discuss what they want to build.

## Step 2: Choose a group

AskUserQuestion: "Which group should have the wiki?"

1. **Main group** — add to your existing main chat
2. **Dedicated group** — create a new group just for the wiki
3. **Other** — pick an existing group

If dedicated: ask which channel and chat, then register with `npx tsx setup/index.ts --step register`.

## Step 3: Design collaboratively

Discuss with the user based on the pattern:
- What's the wiki's domain or topic?
- What kinds of sources will they add? (URLs, PDFs, images, voice notes, books, transcripts)
- Do they want the full three-layer architecture or a lighter version?
- Any specific conventions they care about? (The pattern intentionally leaves this open.)

Based on this discussion, create three things:

### 3a. Directory structure

Create `wiki/` and `sources/` directories in the group folder. Create initial `index.md` and `log.md` per the pattern's Indexing and Logging section. Adapt to the user's domain.

### 3b. Container skill

Create a `container/skills/wiki/SKILL.md` tailored to this user's wiki. This is the schema layer from the pattern — it tells the agent how to maintain the wiki. Base it on the pattern's Operations section (ingest, query, lint) and the conventions you agreed on with the user. Don't over-prescribe — the pattern says "your LLM figures out the rest."

### 3c. Group CLAUDE.md

Add a wiki section to the group's CLAUDE.md that activates the wiki behavior and points to the container skill.

## Step 4: Source handling skills

Check which source-handling capabilities are installed and offer to add missing ones based on what the user plans to ingest:

| Source type | Skill needed | Check |
|---|---|---|
| Images | `/add-image-vision` | `src/channels/image-vision.ts` or similar exists |
| PDFs | `/add-pdf-reader` | `container/skills/pdf-reader/` exists |
| Voice notes | `/add-voice-transcription` | `container/skills/voice-transcription/` exists |

For each missing skill the user needs, invoke it.

### URL handling note

The agent has built-in `WebFetch`, but it returns a summary, not the full document. For wiki ingestion where the full text matters, the container skill should instruct the agent to use `curl` piped through an HTML-to-text conversion instead:

```bash
curl -sL "<url>" | sed 's/<[^>]*>//g'
```

Or better, use `agent-browser` to open the page and extract full text if available. The container skill should note this so the agent gets full content for sources rather than summaries.

### File attachments

If the user's channel supports file attachments (WhatsApp documents, Telegram files, Slack uploads), these arrive in the container's workspace. The container skill should note that attached files can be read directly and saved to `sources/`.

## Step 5: Optional lint schedule

AskUserQuestion: "Want periodic wiki health checks?"

1. **Weekly**
2. **Monthly**
3. **Skip** — lint manually

If yes, schedule via `mcp__nanoclaw__schedule_task` with a prompt based on the pattern's Lint operation.

## Step 6: Build and restart

```bash
npm run build
./container/build.sh
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

Tell the user to test by sending a source to the wiki group.
