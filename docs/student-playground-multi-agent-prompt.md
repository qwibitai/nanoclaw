# Playground Multi-Agent Prompt

A self-contained prompt to give students. They paste it into Claude Code
inside their nanoclaw directory, and the agent extends the Agent Playground
to edit multiple named personas (locked-session model).

---

```
I want to extend the Agent Playground so it can edit multiple named
personas instead of only one "draft". Please implement the following.

## Goal

Right now the playground edits a single persona at groups/draft/.
I want it to edit one of several named drafts (e.g., draft_main,
draft_sandy), each corresponding to a real agent group (telegram_main,
telegram_sandy).

Use a LOCKED-SESSION model, not a free toggle:

- On load, show a picker: "Which agent do you want to edit?"
- The picker lists available drafts (e.g., draft_main, draft_sandy).
- After picking, all playground operations target that draft until
  the user clicks Save (apply to its real group) or Cancel (discard).
- Only then does the picker reappear.

This avoids mid-session state juggling and keeps the UI focused.

## Current code layout

The playground lives in src/playground/. Key files:

- paths.ts — has DRAFT_GROUP_FOLDER = 'draft' hardcoded; derives all
  playground paths from it.
- run.ts — module-level singletons (currentSessionId, activeProcesses,
  currentTraceSessionId).
- state.ts — single state.json tracking dirty flag, last-synced hash.
- draft.ts — writes groups/draft/CLAUDE.md; applyDraftToMain copies
  it to groups/main/CLAUDE.md.
- server.ts — Express + WS server, no groupFolder parameter in routes.
- public/ — frontend HTML/JS.

Current flow = single draft, single state, "apply to main".

## Requirements

1. **Draft discovery.** A draft is any folder under groups/ whose name
   starts with `draft_`. List them dynamically; don't hardcode names.
   Also derive the target group folder by stripping the `draft_`
   prefix (draft_main → telegram_main). If the resulting target
   folder doesn't exist in groups/, skip that draft in the picker.

2. **Active-draft state on the server.** Replace the
   DRAFT_GROUP_FOLDER constant with a runtime variable ("active
   draft") that's set when the user picks, and cleared on save/cancel.
   All paths (state file, skills overlay, attachments, sessions dir)
   derive from the active draft.

3. **Reset singletons on session start.** When a new draft is picked,
   reset currentSessionId, currentTraceSessionId, and kill any
   in-flight activeProcesses. No leakage between sessions.

4. **Per-draft state files.** Move state.json from
   .nanoclaw/playground/draft/state.json to
   .nanoclaw/playground/<draft-name>/state.json. Same for the skills
   overlay and sessions dirs.

5. **Apply semantics.** Replace applyDraftToMain() with
   applyDraft(draftName), which writes the draft's CLAUDE.md to
   groups/<target>/CLAUDE.md (where target = draft-name without the
   "draft_" prefix). Cancel discards edits and leaves the draft
   folder unchanged from its pre-session state (you'll need to
   snapshot/restore or keep a pre-edit copy).

6. **API changes.**
   - GET /api/drafts → list available drafts with their targets.
   - POST /api/session/start with {draft: "draft_sandy"} → sets
     active draft, returns 409 if one is already active.
   - POST /api/session/end with {action: "save" | "cancel"} →
     applies or discards, clears active draft.
   - All existing routes (chat, persona, skills, trace WS) 400 if
     no active draft is set.

7. **Frontend.**
   - Picker screen appears when no session is active.
   - Header shows which draft is currently being edited.
   - A persistent "End session" button offers Save or Cancel.
   - After save or cancel, return to picker.

8. **Seed drafts.** Add a helper that, on server start, creates
   draft_main from groups/main/CLAUDE.md (or telegram_main's
   equivalent) if draft_main doesn't exist yet. Don't auto-create
   draft_sandy unless the target exists — that's for the user to
   decide via a future "new draft" action.

## Before you start

Read these files first so you understand the current architecture:
src/playground/paths.ts, run.ts, state.ts, draft.ts, server.ts,
and src/playground/public/index.html (or whatever the main UI
file is).

Ask me clarifying questions if any of the above is ambiguous for
this codebase. Then outline your plan before writing code.

## Testing

After implementing, verify end-to-end:

1. Start the playground; picker appears.
2. Pick draft_main; edit persona; send a chat message; get a reply.
3. Click Save; confirm groups/main/CLAUDE.md (or the mapped target)
   updated.
4. Picker reappears.
5. Pick a second draft if available; confirm sessions and state are
   fully isolated from the first draft (no stale sessionId, no
   cross-draft file writes).
6. Run `npm run build` and `npx vitest run src/playground/` — no
   type errors, tests pass.

Do not commit. I'll review the diff first.
```

---

## Notes for the instructor

- The "seed draft_main" step (#8) is optional. Drop it if you want students
  to create drafts manually.
- "Cancel discards edits" (requirement #5) requires either a snapshot before
  editing or a git-like stash. The prompt leaves the approach to the
  implementer; if you want a specific strategy, add it (e.g., "copy the
  draft folder to a `.backup` on session start, restore on cancel").
- The prompt deliberately asks the agent to outline before coding so you
  can review the plan before any files are touched.
