# Feature Specification: Obsidian Journal Folder, Audio Linking, and QMD Note Linking

**Feature Branch**: `001-feat-obsidian-journal-audio-linking`
**Created**: 2026-03-16
**Status**: Draft
**Input**: User description: "Update the Obsidian skill so that daily notes go into the journal folder, audio notes from Telegram are linked to daily notes, addendum notes attach follow-on audio, and QMD is used to search and link relevant existing notes inline."

## Clarifications

### Session 2026-03-16

- Q: Should every Telegram voice message automatically create/append to a Journal daily note, or only when explicitly triggered via `/obsidian`? → A: Automatically, but only when the message content (text or voice transcription) contains a variant of the phrase "add to the daily journal." No `/obsidian` command required.
- Q: Should text-only messages also auto-create daily notes, or only voice? → A: Both voice and text, but only when the content contains a variant of "add to the daily journal."

### Session 2026-03-17

- Q: How should trigger phrase matching work — rigid regex or agent-level natural language understanding? → A: Agent-level (LLM) intent detection. The agent determines whether the user's message expresses intent to add content to the daily journal. Matching is case-insensitive and tolerant of natural phrasing variations (e.g., "add this to my daily journal", "put this in the daily journal", "daily journal entry"). The agent strips the intent-bearing phrase from the content before saving.
- Q: What is the internal markdown structure of each entry section within a daily note (heading format, audio embed placement, separators)? → A: Each entry gets an `### HH:MM` timestamp heading (24-hour format from the message timestamp), followed by the transcribed/text content (with inline wikilinks if applicable), followed by the audio embed on its own line (if voice-originated). Entries are separated by a blank line. Audio files are named `YYYY-MM-DD-HHMMSS.ogg` to avoid collisions.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Daily Notes in Journal Folder (Priority: P1)

When the user sends a voice or text message via Telegram that expresses intent to add content to the daily journal (detected by the agent via natural language understanding, not rigid regex), the system automatically creates or appends to a daily note inside the `Journal/` folder within the Obsidian vault — no explicit `/obsidian` command is required. The intent-bearing phrase is stripped from the saved content. If a daily note for the current date already exists in `Journal/`, the new content is appended to it. This ensures all daily entries are organized in a single, predictable location with low-friction capture.

**Why this priority**: This is a structural change that affects every note created. All other stories depend on daily notes landing in the correct location.

**Independent Test**: Send a voice or text note via Telegram and verify the daily note file is created at `Journal/YYYY-MM-DD.md` rather than `YYYY-MM-DD.md` in the vault root.

**Acceptance Scenarios**:

1. **Given** no daily note exists for today, **When** a voice note containing "add to the daily journal" is sent via Telegram, **Then** a new daily note is created at `Journal/YYYY-MM-DD.md` inside the vault with the trigger phrase stripped from the content.
2. **Given** a daily note already exists at `Journal/YYYY-MM-DD.md`, **When** a second message containing the trigger phrase is sent, **Then** the new content is appended to the existing daily note rather than creating a new file.
3. **Given** a voice or text message is sent via Telegram without the trigger phrase, **When** the message is processed, **Then** no Journal daily note is created or modified (standard message flow applies).
4. **Given** the `Journal/` folder does not yet exist in the vault, **When** the first daily note is created, **Then** the `Journal/` folder is created automatically.
5. **Given** old daily notes exist in the vault root (e.g., `YYYY-MM-DD.md`), **When** a new note is created, **Then** the system writes to `Journal/` and does not modify root-level daily notes.

---

### User Story 2 - Audio Attachment on Daily Notes (Priority: P1)

Every audio note that arrives from Telegram is embedded in the daily note that was created (or appended to) because of it. The user can re-listen to the original voice recording directly from the daily note in Obsidian.

**Why this priority**: Audio is the primary source material for notes. Without the audio attached, the user cannot verify or revisit the original recording from within the note.

**Independent Test**: Send a voice message via Telegram. Open the daily note in Obsidian and verify the audio file is embedded and playable.

**Acceptance Scenarios**:

1. **Given** a voice message is sent via Telegram, **When** the daily note is created, **Then** the entry section contains an `### HH:MM` heading, the transcribed content, and the original audio file embedded on its own line using Obsidian's `![[YYYY-MM-DD-HHMMSS.ogg]]` syntax.
2. **Given** a voice message is sent, **When** the audio is saved to the vault, **Then** the audio file is stored at `attachments/audio/YYYY-MM-DD-HHMMSS.ogg` and the daily note references it.
3. **Given** a text-only message (no voice), **When** a note is created, **Then** no audio embed is added to the note.

---

### User Story 3 - Addendum Audio Attachment (Priority: P2)

When the user sends a follow-up voice note that adds to an existing daily note (an addendum), the follow-up audio is also embedded in the note alongside the appended text. Each section of the daily note is accompanied by the audio that produced it.

**Why this priority**: Preserving the audio trail for addendums ensures the user can trace every part of a daily note back to its source recording, maintaining full fidelity.

**Independent Test**: Send an initial voice note, then send a follow-up voice note on the same day. Verify the daily note contains both audio embeds, each paired with their respective transcribed content.

**Acceptance Scenarios**:

1. **Given** a daily note already exists with one audio embed, **When** a follow-up voice note is sent on the same day, **Then** the new transcription and its audio embed are appended to the existing note.
2. **Given** multiple voice notes are sent throughout the day, **When** the user opens the daily note, **Then** each transcribed section has its corresponding audio embed, in chronological order.
3. **Given** a follow-up message is text-only (no voice), **When** it is appended to the daily note, **Then** no audio embed is added for that section.

---

### User Story 4 - Inline Note Linking (Priority: P2)

When a note is created or appended, the system searches the vault for related existing notes and links them inline within the transcribed content using Obsidian wikilinks. The search mechanism is implementation-defined (QMD when available, vault grep otherwise). Only notes that actually exist in the vault are linked. If no relevant notes are found, no links are added.

**Why this priority**: Cross-linking notes surfaces connections the user might not remember, making the vault a knowledge graph rather than isolated entries. However, the feature adds value only if accurate — linking to non-existent notes degrades the experience.

**Independent Test**: Create a note about a topic that has existing related notes in the vault. Verify that relevant notes are linked inline with `[[wikilinks]]`. Then create a note about a novel topic with no related notes and verify no links are added.

**Acceptance Scenarios**:

1. **Given** the vault contains notes about "API migration" and "backend refactor", **When** a new voice note about "migrating the API" is transcribed, **Then** the resulting note contains inline wikilinks to the existing related notes (e.g., `[[API Migration]]`).
2. **Given** the vault search returns results, **When** the agent creates the note, **Then** only notes that actually exist as files in the vault are linked — no broken links.
3. **Given** a note about a completely new topic with no related notes in the vault, **When** the note is created, **Then** no wikilinks are added to the content.
4. **Given** vault search is unavailable or returns an error, **When** a note is created, **Then** the note is still created successfully without links — the system degrades gracefully.
5. **Given** related notes exist, **When** links are added, **Then** links are woven naturally into the note text (not dumped as a list at the bottom).

---

### Edge Cases

- What happens when two voice notes arrive simultaneously for the same day? The system must handle concurrent appends without corrupting the daily note.
- What happens when a voice note arrives just before midnight? The daily note should use the timestamp of the message, not the processing time.
- What happens when the vault search returns notes that have been deleted since the last index update? The system must verify file existence before linking.
- What happens when the audio file fails to save but transcription succeeds? The note should still be created with the transcription, without an audio embed.
- What happens when the `Journal/` folder path contains the daily note but with different content formatting? Appends must preserve existing formatting.
- What happens when the trigger phrase appears mid-sentence (e.g., "I want to add to the daily journal my thoughts on X")? The phrase is stripped and the remaining content is used for the note.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-000**: System MUST automatically create or append to a Journal daily note when the agent (LLM) detects that a Telegram message (voice or text) expresses intent to add content to the daily journal — no explicit `/obsidian` command required. Intent detection is case-insensitive and tolerant of natural phrasing variations (e.g., "add to the daily journal", "add this to my daily journal", "put this in the daily journal", "daily journal entry"). The agent strips the intent-bearing phrase from the note content before saving.
- **FR-001**: System MUST create daily notes at `Journal/YYYY-MM-DD.md` within the vault, not at the vault root.
- **FR-002**: System MUST create the `Journal/` folder automatically if it does not exist.
- **FR-003**: System MUST append to an existing daily note when one already exists for the current date in `Journal/`.
- **FR-004**: System MUST embed the source audio file in the daily note using `![[filename]]` syntax when the note originates from a voice message.
- **FR-005**: System MUST embed follow-up audio files in the daily note when addendum voice notes are appended.
- **FR-006**: System MUST NOT embed audio references when a note or addendum originates from text-only input.
- **FR-007**: System MUST search the vault for related notes when creating or appending journal entries. The search mechanism is implementation-defined (e.g., QMD when available via `/obsidian` context, or vault grep for agent-detected journal entries).
- **FR-008**: System MUST verify that each candidate note actually exists as a file in the vault before creating a wikilink.
- **FR-009**: System MUST NOT add wikilinks when no relevant notes are found or when vault search is unavailable.
- **FR-010**: System MUST weave wikilinks naturally into the note content, not as a disconnected list.
- **FR-011**: System MUST degrade gracefully — if vault search fails, audio save fails, or the journal folder is inaccessible, the note creation must still succeed with whatever components are available.
- **FR-012**: System MUST use the message timestamp (not processing time) to determine which daily note date to use.
- **FR-013**: Each entry section within a daily note MUST start with an `### HH:MM` heading (24-hour format from the message timestamp), followed by a blank line, followed by the content, followed by the audio embed on its own line (if voice-originated). A blank line MUST separate the heading from the content and each entry from the next.
- **FR-014**: Audio files MUST be named `YYYY-MM-DD-HHMMSS.ogg` (derived from the message timestamp) to prevent filename collisions when multiple voice notes arrive on the same day.

### Key Entities

- **Daily Note**: A markdown file at `Journal/YYYY-MM-DD.md` containing one or more entry sections. Accumulates entries throughout the day. Each entry section consists of an `### HH:MM` timestamp heading (24-hour format, derived from the message timestamp), followed by a blank line, followed by the transcribed/text content (with inline wikilinks if applicable), followed by the audio embed on its own line (if voice-originated). A blank line separates each entry from the next.
- **Audio Attachment**: An `.ogg` file stored in `attachments/audio/`, named `YYYY-MM-DD-HHMMSS.ogg` (derived from message timestamp to avoid collisions), and referenced via `![[filename]]` embed syntax within a daily note.
- **Related Note**: An existing vault note discovered via vault search (QMD or grep) that is contextually relevant to the new content, linked inline with `[[wikilink]]` syntax.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of daily notes created from voice or text input are placed in the `Journal/` folder — none in the vault root.
- **SC-002**: Every voice-originated note section contains an embedded audio file that is playable in Obsidian.
- **SC-003**: When related notes exist in the vault, at least one relevant wikilink appears inline in the transcribed content.
- **SC-004**: Zero broken wikilinks are created — every `[[link]]` points to an existing note.
- **SC-005**: Note creation succeeds even when vault search or audio persistence fails, with the available components still present.
- **SC-006**: Multiple voice notes on the same day result in a single daily note with all sections and audio embeds in chronological order.

## Assumptions

- The `Journal/` folder is a new convention; existing daily notes at the vault root are not migrated as part of this feature.
- QMD may be installed and indexed on the host system; if it is not, the agent falls back to vault grep for note discovery, and the system degrades gracefully (as it does today).
- The Obsidian vault path remains at `~/Obsidian/pj-private-vault/pj-private-vault/` on the host and `/workspace/obsidian/pj-private-vault/pj-private-vault/` in containers.
- Audio files continue to be saved to `attachments/audio/` within the vault (existing convention, not changed).
- The agent container skill (obsidian-notes SKILL.md) and host-side code (obsidian.ts, transcription.ts, telegram.ts) all need updates to implement these changes. index.ts does not require changes — journal intent detection is agent-level, and `buildObsidianContext()` remains on the `/obsidian` command path only.
