# Data Model: Obsidian Journal Audio Linking

## Entities

### Daily Note

A markdown file accumulating journal entries throughout a single day.

| Field | Type | Description |
|-------|------|-------------|
| path | string | `Journal/YYYY-MM-DD.md` relative to vault root |
| entries | Entry[] | Ordered list of entry sections, separated by blank lines |

**File location**: `~/Obsidian/pj-private-vault/pj-private-vault/Journal/YYYY-MM-DD.md` (host) or `/workspace/obsidian/pj-private-vault/pj-private-vault/Journal/YYYY-MM-DD.md` (container).

**Lifecycle**: Created on first journal entry for a date. Appended on subsequent entries for the same date. Never overwritten.

### Entry (within Daily Note)

A section within a daily note representing a single journal capture.

| Field | Type | Description |
|-------|------|-------------|
| timestamp_heading | string | `### HH:MM` (24-hour format from message timestamp) |
| content | string | Cleaned text or transcription, with optional inline `[[wikilinks]]` |
| audio_embed | string? | `![[YYYY-MM-DD-HHMMSS.ogg]]` if voice-originated, absent for text-only |

**Markdown format**:
```markdown
### HH:MM

Cleaned content with [[Related Note]] wikilinks woven in naturally.

![[YYYY-MM-DD-HHMMSS.ogg]]
```

**Rules**:
- Entries are separated by a blank line
- Audio embed appears on its own line after the content
- Audio embed is omitted for text-only entries
- Wikilinks are woven into prose, not listed at the bottom

### Audio Attachment

An `.ogg` audio file from a Telegram voice message, stored in the vault.

| Field | Type | Description |
|-------|------|-------------|
| filename | string | `YYYY-MM-DD-HHMMSS.ogg` (derived from message timestamp) |
| directory | string | `attachments/audio/` relative to vault root |
| full_path | string | `attachments/audio/YYYY-MM-DD-HHMMSS.ogg` |

**Naming convention**: `YYYY-MM-DD-HHMMSS.ogg` where the timestamp is extracted from the Telegram message `date` field (Unix seconds * 1000). This ensures uniqueness within a day (sub-second collisions are not realistic for single-user voice messages) and chronological sorting.

**Lifecycle**: Created host-side by `saveAudioToVault()` during transcription, before the agent container starts. The filename is passed to the agent via `[audio-file: YYYY-MM-DD-HHMMSS.ogg]` in the message content.

### Related Note (wikilink target)

An existing note in the vault that is contextually relevant to new content.

| Field | Type | Description |
|-------|------|-------------|
| path | string | Vault-relative path (e.g., `Thoughts/API Migration.md`) |
| name | string | Note name without `.md` extension (e.g., `API Migration`) |

**Discovery**: Found via QMD search (`qmd search <query> -c pj-private-vault --files`) or vault grep. Only notes that exist as files are eligible for wikilinks (FR-008).

**Linking**: Inserted as `[[Note Name]]` inline within the entry content by the agent. The agent uses display text when helpful: `[[Full Note Name|short name]]`.

## State Transitions

### Daily Note Lifecycle

```
[not exists] ---(first journal entry for date)---> [created with single entry]
[exists] ---(subsequent entry same date)---> [appended with new entry section]
```

### Message Processing Flow (for journal entries)

```
Telegram message received
  → Host: transcribeBuffer() (if voice) with message timestamp
  → Host: saveAudioToVault() with timestamp-based filename
  → Host: storeMessage() with [audio-file: ...] marker
  → GroupQueue: serialize per-group
  → Container: agent receives formatted messages
  → Container: agent detects journal intent via NLU
  → Container: agent strips intent phrase from content
  → Container: agent cleans transcription (if voice)
  → Container: agent searches vault for related notes (grep/context file)
  → Container: agent creates/appends to Journal/YYYY-MM-DD.md
  → Container: agent responds with confirmation
```

## Validation Rules

| Rule | Entity | Constraint |
|------|--------|------------|
| Date from message timestamp | Daily Note | YYYY-MM-DD derived from message `date`, not `Date.now()` |
| Time from message timestamp | Entry | HH:MM in 24-hour format from message `date` |
| Audio filename uniqueness | Audio Attachment | YYYY-MM-DD-HHMMSS.ogg — unique per second per day |
| Wikilink existence check | Related Note | Agent must verify file exists before creating `[[link]]` |
| No broken wikilinks | Related Note | Zero tolerance — only link to confirmed-existing notes |
| Graceful degradation | All | Note creation succeeds even if QMD/audio/search fails |
| Append-only daily notes | Daily Note | Never overwrite; always append new entry sections |
| Journal folder auto-create | Daily Note | `Journal/` directory created if absent |
