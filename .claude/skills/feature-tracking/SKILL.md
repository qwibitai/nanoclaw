---
name: feature-tracking
description: "Use when mapping NanoClaw features to exact files/tests before implementation, splitting feature tracking out from initialization, or preventing duplicate code paths. Load for requests like 'which files should I touch', 'what already exists', 'feature inventory', or 'avoid code slop'."
---

# Feature Tracking (NanoClaw)

Project-specific feature ownership map for clean, non-duplicative edits.

## Goal

Build and maintain a deterministic feature catalog so implementation always starts from existing ownership, not from guesswork.

## Outputs

- `.claude/catalog/feature-catalog.seed.json` (curated source-of-truth)
- `.claude/catalog/feature-catalog.json` (generated runtime map)
- `.claude/catalog/feature-catalog.md` (human-readable view)

## Ralph Loop (Practical)

1. Discover current behavior.
2. Map to owning files/tests.
3. Validate references still exist.
4. Reuse existing code path; avoid creating a parallel path.

## Workflow

### 1. Build catalog

```bash
npx tsx .claude/skills/feature-tracking/scripts/build-feature-catalog.ts
```

### 2. Validate catalog integrity

```bash
npx tsx .claude/skills/feature-tracking/scripts/validate-feature-catalog.ts
```

### 3. Resolve feature for a request

```bash
npx tsx .claude/skills/feature-tracking/scripts/locate-feature.ts "ipc dispatch timeout"
```

Use `selected_feature.files` as the initial edit set and `selected_feature.tests` as the initial verification set.

### 4. Audit coverage gaps

```bash
npx tsx .claude/skills/feature-tracking/scripts/audit-feature-coverage.ts
```

Use the report to decide which untracked files are important enough to include in `feature-catalog.seed.json`.

### 5. Enforce touch-set before and after edits

```bash
npx tsx .claude/skills/feature-tracking/scripts/check-touch-set.ts "<feature-id-or-query>"
```

If this fails, do not continue coding until either:
- edits are moved back into owned files, or
- the feature map is intentionally updated first.

## Guardrails

- Do not start implementation until a feature is resolved from the catalog.
- If no feature matches, add/update `feature-catalog.seed.json` first and rebuild.
- For high-risk features, include at least one contract/reliability test in verification.
- Shared files (`shared_files`) indicate integration points; treat them as high-review surfaces.
- Use `check-touch-set.ts` before and after implementation to prevent accidental spread/duplication.

## Quick Commands

```bash
# Full refresh
npx tsx .claude/skills/feature-tracking/scripts/build-feature-catalog.ts \
  && npx tsx .claude/skills/feature-tracking/scripts/validate-feature-catalog.ts

# Query by id
npx tsx .claude/skills/feature-tracking/scripts/locate-feature.ts "container-runtime"

# Coverage audit
npx tsx .claude/skills/feature-tracking/scripts/audit-feature-coverage.ts

# Touch-set guard
npx tsx .claude/skills/feature-tracking/scripts/check-touch-set.ts "jarvis-worker-lifecycle"
```
