# Agreement Sync Protocol

Mandatory protocol for translating an accepted operating agreement into durable repository state.

## Rule

After any accepted agreement affecting Andy/Jarvis behavior, documentation sync is automatic in the same change set.

Do not defer this to a later task.

## Trigger Examples

- role boundary changes (`andy-bot`, `andy-developer`, `jarvis-worker-*`)
- dispatch/completion policy changes
- WebMCP/browser-testing policy changes
- workflow/review-mode defaults (`@claude`, CI governance)
- runtime-vs-prebaked placement decisions

## Required Sync Targets

1. Repository source-of-truth docs under `docs/` (architecture/workflow/operations as applicable)
2. Runtime lane docs under `groups/*` (affected `CLAUDE.md` + `docs/*`)
3. Root `CLAUDE.md` trigger index line(s) if retrieval paths changed
4. Relevant rule files under `.claude/rules/*` when process discipline changed

## Andy -> Jarvis Agreement Handshake

When `andy-developer` accepts an operating change for Jarvis:

1. Andy updates root/source-of-truth docs.
2. Jarvis updates its own lane docs in the same change set:
   - `groups/jarvis-worker-*/docs/workflow/*.md` (procedure changes)
   - `groups/jarvis-worker-*/CLAUDE.md` docs index trigger lines
3. If retrieval paths changed, root `CLAUDE.md` triggers are updated.

No deferred "will update later" step is allowed after agreement acceptance.

## Minimal Completion Checklist

- root docs updated for the agreement
- affected lane docs updated for execution behavior
- outdated references removed
- root `CLAUDE.md` trigger lines aligned
- `git status` shows all sync files in one cohesive commit/PR

## Ownership

- `andy-developer`: initiates agreement, updates lane docs, proposes repo-doc changes
- core maintainer: validates source-of-truth consistency and contract/code alignment

## Non-Compliance

If agreement is applied only in runtime lane docs and not in root docs, treat as incomplete and request immediate rework.
