# Tasks: Obsidian Journal Folder, Audio Linking, and QMD Note Linking

**Input**: Design documents from `/specs/001-feat-obsidian-journal-audio-linking/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, quickstart.md

**Tests**: Tests are included per plan.md (Test-First per constitution). The spec requests tests for journal entry formatting, audio filename generation, and date resolution.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization — no new project structure needed; this feature modifies existing files only (plus one new test file)

- [x] T001 Verify existing project builds and tests pass (`npm run build && npm test && npm run typecheck`)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Host-side changes to audio naming and transcription that ALL user stories depend on. These modify the shared pipeline that voice messages flow through before reaching the container agent.

**CRITICAL**: No user story work can begin until this phase is complete

### Tests for Foundational Phase

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T002 [P] Write test for timestamp-based audio filename generation (`YYYY-MM-DD-HHMMSS.ogg` from a Date) in src/obsidian.test.ts
- [ ] T003 [P] Write test for `saveAudioToVault()` accepting a `Date` parameter and producing timestamp-named files in src/obsidian.test.ts

### Implementation for Foundational Phase

- [ ] T004 Modify `saveAudioToVault()` in src/obsidian.ts to accept a `messageTimestamp: Date` parameter and name files `YYYY-MM-DD-HHMMSS.ogg` instead of `voice-{id}.ogg`
- [ ] T005 Modify `transcribeBuffer()` in src/transcription.ts to accept an optional `messageTimestamp: Date` in the options parameter and pass it through to `saveAudioToVault()`
- [ ] T006 Modify Telegram voice handler in src/channels/telegram.ts to pass `new Date(ctx.message.date * 1000)` as `messageTimestamp` to `transcribeBuffer()`
- [ ] T007 Run tests and verify T002, T003 pass (`npm test`)

**Checkpoint**: Audio files are now named with message timestamps. All existing voice message handling still works.

---

## Phase 3: User Story 1 — Daily Notes in Journal Folder (Priority: P1) MVP

**Goal**: When the agent detects journal intent in a Telegram message (voice or text), it creates or appends to `Journal/YYYY-MM-DD.md` in the vault instead of a root-level daily note. Intent detection is LLM-based (agent-level), not host-side regex.

**Independent Test**: Send a voice or text note via Telegram containing "add to the daily journal" and verify the daily note file is created at `Journal/YYYY-MM-DD.md` rather than `YYYY-MM-DD.md` in the vault root.

### Tests for User Story 1

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [ ] T008 [P] [US1] Write test for journal entry formatting (with `### HH:MM` heading, content, no audio) in src/obsidian.test.ts
- [ ] T009 [P] [US1] Write test for journal entry formatting (with `### HH:MM` heading, content, and audio embed line) in src/obsidian.test.ts
- [ ] T010 [P] [US1] Write test for date extraction from message timestamp (derives `YYYY-MM-DD` from a Date, not from `Date.now()`) in src/obsidian.test.ts

### Implementation for User Story 1

- [ ] T011 [US1] Add pure function `formatJournalEntry(timestamp: Date, content: string, audioFile?: string): string` in src/obsidian.ts that produces the `### HH:MM` + content + optional `![[audioFile]]` format per data-model.md
- [ ] T012 [US1] Add pure function `getJournalNotePath(timestamp: Date): string` in src/obsidian.ts that returns `Journal/YYYY-MM-DD.md` relative to vault root
- [ ] T013 [US1] Update the obsidian-notes container skill in container/skills/obsidian-notes/SKILL.md to document: Journal/ folder convention for daily notes, `### HH:MM` entry format, journal intent detection (NLU-based, no `/obsidian` required), trigger phrase stripping rules, and updated vault structure showing `Journal/` folder
- [ ] T014 [US1] Run tests and verify T008, T009, T010 pass (`npm test`)

**Checkpoint**: The container agent skill knows about Journal/ folder and entry format. Host-side helpers for formatting and path resolution are available. Send a test message and verify `Journal/YYYY-MM-DD.md` is created.

---

## Phase 4: User Story 2 — Audio Attachment on Daily Notes (Priority: P1)

**Goal**: Every voice-originated journal entry embeds the source audio file using `![[YYYY-MM-DD-HHMMSS.ogg]]` syntax. The audio file is saved to `attachments/audio/` and the embed appears on its own line after the transcribed content.

**Independent Test**: Send a voice message via Telegram. Open the daily note in Obsidian and verify the audio file is embedded and playable.

### Implementation for User Story 2

- [ ] T015 [US2] Update the obsidian-notes container skill in container/skills/obsidian-notes/SKILL.md to document audio embed placement within `### HH:MM` entry sections (audio embed on own line after content, omitted for text-only entries, uses `![[YYYY-MM-DD-HHMMSS.ogg]]` syntax)
- [ ] T016 [US2] Write test in src/obsidian.test.ts that verifies `saveAudioToVault()` returns a filename matching `YYYY-MM-DD-HHMMSS.ogg` format and that the `[audio-file: ...]` marker injected by `transcribeBuffer()` uses this timestamp-based filename (not the legacy `voice-{id}.ogg` format). Run `npm test` and confirm the test passes (it should, since T004 already implemented the rename).

**Checkpoint**: Voice messages produce entries with audio embeds. Text-only messages produce entries without audio embeds. Audio files at `attachments/audio/YYYY-MM-DD-HHMMSS.ogg` are playable in Obsidian.

---

## Phase 5: User Story 3 — Addendum Audio Attachment (Priority: P2)

**Goal**: Follow-up voice notes on the same day append to the existing daily note with their own `### HH:MM` section and audio embed, preserving the full audio trail.

**Independent Test**: Send an initial voice note, then send a follow-up voice note on the same day. Verify the daily note contains both audio embeds, each paired with their respective transcribed content.

### Implementation for User Story 3

- [ ] T017 [US3] Update the obsidian-notes container skill in container/skills/obsidian-notes/SKILL.md to document addendum behavior: appending new `### HH:MM` sections (each with their own audio embed) to existing `Journal/YYYY-MM-DD.md` files, preserving existing content and chronological order

**Checkpoint**: Multiple voice notes on the same day produce a single daily note with multiple entry sections, each with its own audio embed, in chronological order.

---

## Phase 6: User Story 4 — QMD-Powered Inline Note Linking (Priority: P2)

**Goal**: When a journal entry is created, the agent searches the vault for related notes and weaves inline `[[wikilinks]]` naturally into the content. Only existing notes are linked. Graceful degradation when search is unavailable.

**Independent Test**: Create a note about a topic that has existing related notes in the vault. Verify relevant notes are linked inline. Create a note about a novel topic — verify no links are added.

### Implementation for User Story 4

- [ ] T018 [US4] Update the obsidian-notes container skill in container/skills/obsidian-notes/SKILL.md to document: for journal entries, the agent should grep the vault for related notes (since `/obsidian` context may not be available), verify file existence before creating `[[wikilinks]]`, weave links naturally into prose, and degrade gracefully if search fails
- [ ] T019 [US4] Verify the existing `buildObsidianContext()` in src/obsidian.ts remains on the `/obsidian` command path only (per research.md R4 decision) — no changes needed to src/index.ts for QMD routing

**Checkpoint**: Journal entries contain inline wikilinks to related notes when they exist. No broken links. Notes are created successfully even when search fails.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: End-to-end verification, container rebuild, and documentation

- [ ] T020 [P] Run full test suite, type checking, and linting (`npm test && npm run typecheck && npm run build`)
- [ ] T021 [P] Clear stale agent-runner copies and rebuild container (`rm -rf data/sessions/*/agent-runner-src/ && ./container/build.sh`)
- [ ] T022 Run quickstart.md end-to-end validation (send text message with trigger phrase, voice message, addendum voice message, and non-trigger message per specs/001-feat-obsidian-journal-audio-linking/quickstart.md)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion — BLOCKS all user stories
- **User Story 1 (Phase 3)**: Depends on Foundational (Phase 2) completion
- **User Story 2 (Phase 4)**: Depends on Foundational (Phase 2) and User Story 1 (Phase 3) — US2 relies on the Journal/ folder convention and entry format established in US1
- **User Story 3 (Phase 5)**: Depends on User Story 2 (Phase 4) — addendum behavior extends the audio attachment pattern
- **User Story 4 (Phase 6)**: Depends on User Story 1 (Phase 3) — can run in parallel with US2/US3 since it only adds linking to existing entry flow
- **Polish (Phase 7)**: Depends on all user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational (Phase 2) — no dependencies on other stories
- **User Story 2 (P1)**: Depends on US1 — needs Journal/ folder and entry format
- **User Story 3 (P2)**: Depends on US2 — extends audio attachment pattern
- **User Story 4 (P2)**: Can start after US1 — independent of US2/US3

### Within Each User Story

- Tests MUST be written and FAIL before implementation
- Pure functions (formatters, path helpers) before skill documentation
- Skill documentation before integration verification
- Story complete before moving to next priority

### Parallel Opportunities

- T002, T003 can run in parallel (different test cases, same test file — coordinate)
- T008, T009, T010 can run in parallel (different test cases in src/obsidian.test.ts)
- T020, T021 can run in parallel (independent verification tasks)
- US4 (Phase 6) can run in parallel with US2/US3 (Phases 4-5) since it modifies only the skill doc's linking section

---

## Parallel Example: User Story 1

```bash
# Launch all tests for User Story 1 together:
Task: "Write test for journal entry formatting (no audio) in src/obsidian.test.ts"
Task: "Write test for journal entry formatting (with audio) in src/obsidian.test.ts"
Task: "Write test for date extraction from message timestamp in src/obsidian.test.ts"

# Then implement sequentially:
Task: "Add formatJournalEntry() in src/obsidian.ts"
Task: "Add getJournalNotePath() in src/obsidian.ts"
Task: "Update obsidian-notes SKILL.md"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (verify build)
2. Complete Phase 2: Foundational (timestamp-based audio naming)
3. Complete Phase 3: User Story 1 (Journal/ folder + entry format)
4. **STOP and VALIDATE**: Send a test message and verify Journal/YYYY-MM-DD.md is created
5. Deploy if ready

### Incremental Delivery

1. Complete Setup + Foundational -> Audio naming fixed
2. Add User Story 1 -> Journal/ folder works -> Deploy (MVP!)
3. Add User Story 2 -> Audio embeds in entries -> Deploy
4. Add User Story 3 -> Addendum audio works -> Deploy
5. Add User Story 4 -> Inline wikilinks -> Deploy
6. Each story adds value without breaking previous stories

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Verify tests fail before implementing
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- The spec requests TDD (plan.md constitution check: "Test-First | PASS"), so test tasks are included
- Most implementation changes are to existing files (src/obsidian.ts, src/transcription.ts, src/channels/telegram.ts) and the container skill document (container/skills/obsidian-notes/SKILL.md). Only one new file is created: src/obsidian.test.ts
