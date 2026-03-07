# Doc Creation Contract

Admission gate for creating a new `docs/*.md` file or adding a new root `CLAUDE.md` trigger.

Use this before adding workflow docs, operations docs, runbooks, maps, or any new retrieval path.

## Goal

Keep documentation compact, canonical, and verifiable.

Every new doc must earn its place by owning one clear decision surface and reducing failure risk or retrieval cost.

## Allowed Doc Types

Choose exactly one type before writing:

1. `contract`
   - Canonical truth for requirements, fields, invariants, validation, and exit criteria.
2. `workflow-loop`
   - End-to-end execution flow for a recurring task class.
3. `runbook`
   - Narrow debug or ops handling for a specific symptom family.
4. `map`
   - Routing, ownership, placement, or inventory reference.

If the proposed doc does not fit one of these types cleanly, do not create it yet.

## Admission Questions

Answer all of these before creating the doc:

1. What exact gap exists that current docs do not cover?
2. Which existing doc is closest, and why can it not absorb this change?
3. What single decision, contract, or task boundary will this doc own?
4. What doc type is it: `contract`, `workflow-loop`, `runbook`, or `map`?
5. Which script, command, test, or evidence artifact proves the doc matters?
6. Which existing docs must link to it or stop duplicating it?
7. What exact `CLAUDE.md` trigger line retrieves it, if any?
8. What would silently break, drift, or become slower without this doc?

If answers `2`, `3`, `5`, or `8` are weak, extend an existing doc instead of creating a new one.

## Placement Rule

Pick the narrowest correct location:

- `docs/workflow/`: recurring execution flows, gates, and runbooks
- `docs/operations/`: ownership, routing, sync, placement, governance maps
- `docs/architecture/`: stable design and system boundaries
- `docs/reference/`: baseline requirements/spec/security truth
- `docs/troubleshooting/`: platform-specific or incident-specific debug support
- `docs/research/`: evidence artifacts, not active workflow authority

Do not place active workflow authority in `docs/research/` or historical context in `docs/reference/`.

## Canonical Ownership Rule

Every new doc must declare:

1. its doc type
2. its canonical owner
3. which adjacent docs it must not duplicate

One topic gets one field-level or policy-level owner.
Other docs may reference that owner, but must not partially mirror it.

## `CLAUDE.md` Trigger Gate

Add a root trigger only when all are true:

1. the doc is needed in repeated work, not a one-off
2. omission creates real failure risk or retrieval drag
3. no existing trigger already covers the same action
4. the trigger can be expressed in one line

Required format:

```text
BEFORE <specific action> → read docs/<topic>.md
```

Rules:

- one trigger = one action
- no narrative paragraphs in `CLAUDE.md`
- no multi-doc trigger unless both docs are required together
- a new doc should introduce at most one new trigger line

## Document Template

Use the smallest structure that matches the doc type.

Minimum required sections:

```md
# <Title>

## Purpose
One sentence describing what the doc is for.

## Doc Type
`contract` | `workflow-loop` | `runbook` | `map`

## Canonical Owner
State which file/doc owns the truth for this topic.

## Use When
Concrete entry condition.

## Do Not Use When
Boundary with adjacent docs.

## Verification
Commands, scripts, checks, or evidence artifacts.

## Related Docs
Only directly adjacent docs.
```

## Type-Specific Sections

For `contract` docs, include:

- `Requirements`
- `Field Rules`
- `Validation Gates`
- `Exit Criteria`

For `workflow-loop` docs, include:

- `Precedence`
- `Phases`
- `Exit Criteria`
- `Anti-Patterns`

For `runbook` docs, include:

- `Quick Diagnostic`
- `Issue Categories`
- `Branch Actions`
- `Safe Handling Notes`

For `map` docs, include:

- `Decision Table`
- `Ownership`
- `Update Surfaces`

## Patterns To Follow

- keep one canonical owner per topic
- prefer references over partial restatements
- include explicit entry and exit conditions
- bind the doc to script-backed verification when possible
- keep examples minimal and representative
- update mirrors and adjacent docs in the same change set

## Anti-Patterns

Do not create docs that:

- partially mirror field requirements from a canonical contract
- duplicate the same policy table in multiple places
- say “use this first” for the same scenario as another entry doc
- exist without a verification path or evidence surface
- exist only because the topic feels important
- add multiple new `CLAUDE.md` triggers for one narrow workflow

## Creation Workflow

When a new doc passes the admission gate:

1. create the doc with the required template sections
2. update `DOCS.md`
3. update `docs/README.md` only if the new doc belongs on the curated landing page
4. update root `CLAUDE.md` trigger lines if retrieval paths changed
5. update `AGENTS.md` when root instruction policy changed
6. remove duplicated content from adjacent docs in the same change set

## Verification Gate

Before finishing:

1. `bash scripts/check-workflow-contracts.sh`
2. `bash scripts/check-claude-codex-mirror.sh`
3. `bash scripts/check-tooling-governance.sh`
4. `rg -n "<new-doc-name>|<new-trigger-target>" .` to confirm intended references

The new doc is complete only when it reduces ambiguity instead of creating a second authority surface.
