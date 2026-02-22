# /create-skill — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

## Original Vision

> **Raw user input:** "I want to have a way to allow users to create a skill. It's a skill to create skills, a meta-skill, if you will, following the current new implementation of skills. It also needs to take into account the current user situation but also make the skill generalizable. Research should let the user first build it, test it out internally, and then after the test is complete and QA'd, only then suggest opening a PR to upstream. It should be a fully fledged flow."

**Goal:** Build `/create-skill` — a meta-skill that guides users through creating, testing, QA-ing, and optionally upstreaming new NanoClaw skills.

**Problem:** Skill creation is undocumented (users don't know the required structure) and there's no quality gate (contributions are inconsistent/untested). This solves both.

**Platform:** CLI (Claude Code skill) — pure SKILL.md, no helper scripts or CLI tools

**Scope:** Production-ready — this teaches the system, it must be the gold standard

## Tech Stack

Fully inherited from NanoClaw:
- **Runtime:** Claude Code (skill executor)
- **Tools:** Claude Code built-ins (Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion)
- **Testing:** Vitest
- **Git/PR:** `gh` CLI
- **Infra:** Skills engine, manifest.yaml, .nanoclaw/state.yaml, intent files

No new dependencies needed.

## Skill System Reference

### Skill Directory Structure
```
.claude/skills/{name}/
├── SKILL.md              # Frontmatter + markdown guide
├── manifest.yaml         # Metadata, deps, conflicts, test cmd, structured ops
├── add/                  # New files to add
├── modify/               # Files to merge (+ .intent.md companions)
└── tests/                # Integration tests
```

### manifest.yaml Schema
```yaml
skill: name
version: 1.0.0
description: "..."
core_version: 0.1.0
adds: [paths...]
modifies: [paths...]
conflicts: []
depends: []
test: "npx vitest run ..."
structured:
  npm_dependencies: {}
  env_additions: []
```

### State Tracking (.nanoclaw/state.yaml)
Records applied skills with file hashes. `/create-skill` extends this with creation status: `draft → tested → submitted`.

## Data Model

| Entity | Description | Location |
|--------|-------------|----------|
| Skill Package | Generated artifacts (SKILL.md, manifest, code, tests) | `.claude/skills/{name}/` |
| Creation State | Status of skills built via meta-skill | `.nanoclaw/state.yaml` |
| Fork Context | Read-only: applied skills, src/, package.json | Various |

### Data Flow
1. User describes what the skill should do (high-level, not file-level)
2. Claude inspects the fork state
3. Claude determines which files need to change, generates everything
4. Complete package output to `.claude/skills/{name}/`
5. Status recorded in `.nanoclaw/state.yaml`

### Key Design Decisions
- **Users describe WHAT, not WHERE** — Claude analyzes the codebase and figures out which files to modify
- **Generalizability via dependency detection** — if the skill depends on other applied skills, adds them to `depends:` in manifest
- **Dual testing** — verify on user's fork AND clean NanoClaw base
- **Target user's current fork version** — record in `core_version`, not latest upstream

## User Flows

### Flow 1: Idea → Skill → Test → (Optional) PR

| Step | Action |
|------|--------|
| 1. Trigger | User describes idea organically, Claude suggests `/create-skill` |
| 2. Inspect | Read fork state (state.yaml, src/, package.json, existing skills) |
| 3. Interview | Adaptive depth — simple skills: quick; complex skills: thorough |
| 4. Scaffold | Generate full package: SKILL.md, manifest, add/, modify/ + intent files, tests/ |
| 5. Apply & Test | Apply via skills engine → vitest → user manual QA |
| 6. Iterate | Fix issues, re-test |
| 7. Track | Update state.yaml (draft → tested) |
| 8. PR Prep | Review generalizability, strip fork-specific assumptions, clean-base test |
| 9. Submit | Create PR via `gh`, update state to "submitted" |

### Flow 2: Resume/Iterate on Existing Skill

| Step | Action |
|------|--------|
| 1. Detect | Find draft/tested skill in state.yaml |
| 2. Inspect | Read existing skill directory |
| 3. Ask | "What do you want to change?" |
| 4. Update | Modify relevant artifacts |
| 5. Re-test | Apply, test, manual QA |
| 6. Track | Update state |

### User Stories
1. As a fork owner, I want to describe what I want my assistant to do so that Claude builds a properly structured skill without me learning the skill system.
2. As a contributor, I want to build, test, and PR a skill so quality meets standards before review.
3. As a skill author, I want to resume unfinished skill work without losing progress.

### Edge Cases
- Fork has custom (non-skill) modifications — handle gracefully
- Skill conflicts with existing applied skill — detect and warn
- Tests pass on fork but fail on clean base — dependency not declared
- Skill partially exists — detect and offer to continue from existing state

## Architecture Decisions

- **Pure SKILL.md, no CLI** — consistency with NanoClaw philosophy (skills over features). Claude Code is the executor.
- **Adaptive interview depth** — avoids over-questioning for simple skills while ensuring complex skills are thoroughly scoped
- **Canonical SKILL.md template as separate file** — lives at `.claude/skills/create-skill/templates/SKILL.md.template` for independent maintenance
- **Generate all artifacts then review** — batching reduces cognitive overhead vs. file-by-file approval
- **Work within current engine limits** — don't generate skills requiring engine changes; keeps the meta-skill reliable
- **State in .nanoclaw/state.yaml** — single source of truth, consistent with existing skill tracking

## Coding Style

- Generated code follows NanoClaw conventions (functional, minimal) with flexibility for skill-specific needs
- New canonical SKILL.md template: clear sections, optional phases, always-present testing section
- Every generated skill gets: manifest validation + file existence + apply-build-verify integration test

---

## Implementation Phases

### Phase 1: Design Canonical SKILL.md Template
- [ ] Audit all existing SKILL.md files for patterns
- [ ] Draft `.claude/skills/create-skill/templates/SKILL.md.template`
- [ ] Define required vs optional sections
- [ ] Define frontmatter schema
- [ ] Get user approval on template

### Phase 2: Write the Meta-Skill SKILL.md
- [ ] Create `.claude/skills/create-skill/SKILL.md`
- [ ] Implement Phase 1: Fork inspection logic
- [ ] Implement Phase 2: Adaptive interview flow
- [ ] Implement Phase 3: Scaffold generation (SKILL.md, manifest, code, intent files, tests)
- [ ] Implement Phase 4: Apply & test flow
- [ ] Implement Phase 5: PR preparation flow
- [ ] Implement resume/iterate flow (detect existing drafts in state.yaml)

### Phase 3: Create Template Artifacts
- [ ] Manifest.yaml template with all fields documented
- [ ] Intent file (.intent.md) template
- [ ] Test file template (vitest structure)
- [ ] Example: simple interactive skill scaffolded from template
- [ ] Example: code modification skill scaffolded from template

### Phase 4: Integration Testing
- [ ] Test: create a simple interactive skill end-to-end
- [ ] Test: create a code modification skill end-to-end
- [ ] Test: resume an unfinished skill
- [ ] Test: PR preparation flow
- [ ] Test: clean-base compatibility verification
- [ ] Test: dependency detection for fork-specific skills

### Phase 5: Polish & Documentation
- [ ] Edge case handling (conflicts, partial skills, non-skill modifications)
- [ ] Error messages for unsupported requests (engine limit detection)
- [ ] Update README.md contributing section to reference `/create-skill`
- [ ] Add `/create-skill` to the RFS section as "available"

---

## Testing Strategy

- **Manifest validation:** Generated manifest matches schema, valid YAML
- **File existence:** All files declared in `adds`/`modifies` exist
- **Integration:** Apply skill → build → verify functionality
- **Clean-base compatibility:** Skill works on vanilla NanoClaw (not just user's fork)
- **Resume:** State correctly tracks draft/tested/submitted lifecycle

## Known Risks

| Risk | Mitigation |
|------|------------|
| Generated skills break when NanoClaw core changes | Clean-base testing, core_version field, intent files for re-resolution |
| SKILL.md becomes too complex to maintain | Modular structure with separate templates; canonical template is independently updatable |
| Claude generates incorrect modify/ files | Intent files guide conflict resolution; user manual QA step catches issues |
| Fork-specific assumptions leak into upstream PRs | PR prep phase explicitly strips fork assumptions; clean-base test verifies |

## Open Questions
- Should the canonical template be versioned separately from the meta-skill?
- How to handle the case where a skill needs both code modification AND interactive setup phases?
- Should there be a "skill marketplace" or registry beyond the GitHub repo?
