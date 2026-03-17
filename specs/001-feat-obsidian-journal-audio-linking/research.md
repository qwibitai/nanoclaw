# Research: Obsidian Journal Audio Linking

## R1: Intent Detection Strategy — Agent-level vs. Host-level

**Decision**: Agent-level (LLM) intent detection performed by the container agent, not regex on the host.

**Rationale**: The spec explicitly requires natural language understanding for detecting journal intent ("add this to my daily journal", "put this in the daily journal", "daily journal entry", etc.). Regex patterns would be fragile and require constant maintenance. The LLM agent already processes every message and can detect intent with high accuracy. The host-side code only needs to know *after* the agent decides — it does not need to pre-filter.

**Implementation approach**: The host does NOT detect journal intent. Instead, the container agent (via the obsidian-notes skill) determines whether the user wants to add content to the daily journal. The agent then uses the vault filesystem directly (it has the vault mounted at `/workspace/obsidian/pj-private-vault/pj-private-vault/`) to create or append to `Journal/YYYY-MM-DD.md`.

**Why not host-side detection**: Adding LLM-based intent detection on the host would require a separate API call for every message, adding latency and cost. The agent already receives all messages and can make this determination as part of its normal processing.

**Alternatives considered**:
- Host-side regex: rejected per spec ("agent-level, not rigid regex")
- Host-side LLM pre-filter: rejected (unnecessary cost, agent already processes messages)
- New `/journal` slash command: rejected (spec explicitly says "no explicit `/obsidian` command required")

## R2: Audio File Naming — Timestamp-based vs. ID-based

**Decision**: Name audio files `YYYY-MM-DD-HHMMSS.ogg` based on the message timestamp.

**Rationale**: The spec requires `YYYY-MM-DD-HHMMSS.ogg` format (FR-014). The current codebase uses `voice-nanoclaw-voice-{Date.now()}.ogg` based on processing time, which violates FR-012 (must use message timestamp, not processing time) and makes filenames unreadable.

**Implementation approach**: Modify `saveAudioToVault()` to accept a `Date` parameter (the message timestamp) and derive the filename from it. The `transcribeBuffer()` function passes this through. The Telegram channel handler extracts `ctx.message.date * 1000` (already done for the `timestamp` field) and passes it to `transcribeBuffer()`.

**Alternatives considered**:
- Keep current `voice-{id}.ogg` naming: rejected (violates FR-014)
- Use UUID-based naming: rejected (spec requires timestamp-based naming for readability)

## R3: Daily Note Structure — Where Does the Agent Create Notes?

**Decision**: The container agent creates/appends to `Journal/YYYY-MM-DD.md` directly via filesystem operations (Bash, Write, Edit tools).

**Rationale**: The agent already has the Obsidian vault mounted read-write at `/workspace/obsidian/pj-private-vault/pj-private-vault/`. The obsidian-notes skill already instructs the agent to create notes via filesystem operations. The change is updating the skill to use `Journal/` instead of the vault root for daily notes, and to use the new entry format with `### HH:MM` headings.

**Implementation approach**:
1. Update the obsidian-notes SKILL.md to document the `Journal/` folder convention and the new entry format.
2. The host-side `buildObsidianContext()` already provides QMD search results and existing tags via `/workspace/ipc/obsidian_context.json` — no change needed there.
3. Audio files are saved host-side (before the container starts) via `saveAudioToVault()`, and the filename is passed to the agent via the `[audio-file: ...]` marker in the message content.

**Alternatives considered**:
- Host-side note creation: rejected (the agent needs to clean up transcriptions, detect intent, weave wikilinks — all LLM tasks)
- New MCP tool for note creation: rejected (KISS — filesystem operations work fine and are already the established pattern)

## R4: Obsidian Context Enrichment — When to Build It

**Decision**: Build obsidian context (QMD search + existing tags) for ALL messages from registered groups, not just `/obsidian` commands.

**Rationale**: Since journal intent detection is agent-level, the host cannot know in advance which messages will become journal entries. The agent needs QMD search results and existing tags available when it decides to create a note. Building context for every message is acceptable because `searchRelatedNotes()` already degrades gracefully (empty results if QMD is unavailable) and the operation is fast (~1-2s).

**Implementation approach**: Move the `buildObsidianContext()` call from the `/obsidian` command handler to the general message storage path, but only for messages that contain voice transcriptions or have sufficient text content (to avoid unnecessary QMD calls for short messages like "ok" or "thanks"). The context file is written to the group's IPC directory where the agent can read it.

**Revision**: On reflection, building context for *every* message is wasteful. A simpler approach: the agent can request QMD search on-demand via the `obsidian_context.json` file (which is already written for `/obsidian` commands), or fall back to `grep` in the vault (which the skill already documents). The host-side enrichment for `/obsidian` remains unchanged. For intent-detected journal entries (no `/obsidian` command), the agent can grep the vault itself if needed. This avoids adding a QMD call to every message path.

**Final decision**: Keep `buildObsidianContext()` only on the `/obsidian` command path. For agent-detected journal entries, the agent searches the vault using grep (already documented in the skill). This is simpler and avoids performance regression.

**Alternatives considered**:
- Call QMD for every message: rejected (wasteful for non-journal messages)
- New MCP tool for on-demand QMD: rejected (YAGNI — grep works, and the agent can use the existing obsidian_context.json when `/obsidian` is used)

## R5: Concurrent Append Safety

**Decision**: Rely on the existing `GroupQueue` serialization — only one agent container runs per group at a time.

**Rationale**: The spec raises the edge case of "two voice notes arriving simultaneously for the same day." In NanoClaw's architecture, messages are serialized per group via `GroupQueue`. Multiple messages arriving for the same group are batched and processed in a single agent invocation. If a second message arrives while the agent is running, it's either piped to the active container or queued for the next invocation. The agent handles all messages in order within a single filesystem session, so concurrent file corruption is not possible.

**Alternatives considered**:
- File-level locking on daily notes: rejected (unnecessary given GroupQueue serialization)
- Append-only write pattern with atomic rename: rejected (over-engineering for a single-user system)

## R6: Midnight Boundary — Message Timestamp vs. Processing Time

**Decision**: Use the message timestamp (`ctx.message.date * 1000` in Telegram) to determine which daily note receives the entry.

**Rationale**: FR-012 requires using the message timestamp, not processing time. The Telegram channel already captures message timestamp as `new Date(ctx.message.date * 1000).toISOString()` and passes it in the message object. The agent receives this timestamp in the formatted message XML (`<message time="...">`) and uses it to determine the date for `Journal/YYYY-MM-DD.md` and the heading for `### HH:MM`.

**Implementation approach**: The message timestamp is already available to the agent. The obsidian-notes skill needs to document that the agent should extract the date from the message timestamp, not use `Date.now()`.

**Alternatives considered**:
- Use processing time: rejected (violates FR-012, causes midnight boundary issues)
