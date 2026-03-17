# Implementation Plan: Obsidian Journal Folder, Audio Linking, and QMD Note Linking

**Branch**: `001-feat-obsidian-journal-audio-linking` | **Date**: 2026-03-17 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/001-feat-obsidian-journal-audio-linking/spec.md`

## Summary

Update the NanoClaw Obsidian integration so that daily notes are placed in a `Journal/` folder, voice messages from Telegram are automatically embedded alongside their transcriptions, addendum voice notes append with their own audio embeds, and QMD search results are used to weave inline wikilinks to related existing notes. The key design change is moving from an explicit `/obsidian` command to agent-level (LLM) intent detection: messages containing natural language variants of "add to the daily journal" are automatically routed through the obsidian enrichment pipeline without requiring a slash command.

## Technical Context

**Language/Version**: TypeScript 5.x (Node.js, ESM)
**Primary Dependencies**: grammy (Telegram), whisper.cpp (transcription), qmd (vault search), better-sqlite3
**Storage**: Obsidian vault on filesystem (`~/Obsidian/pj-private-vault/pj-private-vault/`), SQLite for message state
**Testing**: Vitest
**Target Platform**: macOS host + Linux containers (Docker/OrbStack)
**Project Type**: Background service with channel-based message routing
**Performance Goals**: N/A (single-user system, low throughput)
**Constraints**: Audio files must be saved before the agent container starts (host-side); agent containers have the vault mounted at `/workspace/obsidian/pj-private-vault/pj-private-vault/`
**Scale/Scope**: Single user, ~10-20 daily notes/month, 1-5 voice messages/day

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Readability First | PASS | Changes use descriptive names, clear data flow |
| II. Functional Design | PASS | `buildJournalEntry()` is a pure formatter; `saveAudioToVault()` takes inputs and returns deterministic output paths |
| III. Maintainability | PASS | No clever tricks; changes follow established host+container pattern |
| IV. Best Practices | PASS | Follows existing NanoClaw patterns (IPC context files, container skills, Obsidian markdown conventions) |
| V. Simplicity (KISS & YAGNI) | PASS | No new services or infrastructure; extends existing obsidian.ts, transcription.ts, telegram.ts, index.ts, and the container skill |
| Test-First | PASS | Tests for journal entry formatting, audio filename generation, timestamp-based date resolution |
| Quality Gates | PASS | All changes go through existing vitest + tsc --noEmit pipeline |

**Post-Phase 1 re-check**: PASS. No new dependencies, no new architectural layers. The design adds pure functions to existing modules and extends the container skill document.

## Project Structure

### Documentation (this feature)

```text
specs/001-feat-obsidian-journal-audio-linking/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
└── tasks.md             # Phase 2 output (created by /speckit.tasks)
```

### Source Code (repository root)

```text
src/
├── obsidian.ts              # MODIFY: add Journal/ path logic, entry formatting, timestamp-based audio naming
├── transcription.ts         # MODIFY: accept message timestamp for audio filename, pass through to saveAudioToVault
├── channels/
│   └── telegram.ts          # MODIFY: pass message timestamp to transcribeBuffer, include timestamp in audio-file metadata
├── index.ts                 # NO CHANGES: journal intent detection is agent-level per research.md R1/R4; buildObsidianContext() stays on /obsidian path only

container/skills/
└── obsidian-notes/
    └── SKILL.md             # MODIFY: update vault structure, add Journal/ workflow, update entry format docs

src/obsidian.test.ts         # NEW: tests for journal entry formatting, audio filename, date resolution
```

**Structure Decision**: This feature modifies existing files only (plus one new test file). No new directories or modules are needed. The changes follow the existing host-side enrichment + container skill pattern already established for `/obsidian` and `/draft`.

## Complexity Tracking

No constitution violations. No complexity tracking needed.
