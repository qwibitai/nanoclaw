---
name: nanoclaw-implementation
description: "Use when implementing or modifying NanoClaw features with strict file ownership discipline from feature-tracking. Load for feature delivery where you need to avoid duplicated logic, reuse existing code paths, and keep edits scoped to the right files."
---

# NanoClaw Implementation

Project-specific implementation workflow that depends on `feature-tracking`.

## Mandatory Inputs

- A resolved feature from `feature-catalog.json`
- A bounded edit set (`selected_feature.files`)
- A bounded test set (`selected_feature.tests`)

## Workflow

### 1. Resolve target feature

```bash
npx tsx .claude/skills/feature-tracking/scripts/locate-feature.ts "<request>"
```

### 2. Guard touch-set before coding

```bash
npx tsx .claude/skills/feature-tracking/scripts/check-touch-set.ts "<feature-id-or-query>"
```

### 3. Run duplicate-path check before coding

```bash
# Search for existing implementations before adding new modules/functions
rg -n "<key function name|behavior keyword>" src groups scripts
```

### 4. Apply touch-set discipline

- Edit files in `selected_feature.files` first.
- Add new files only when existing file boundaries are proven insufficient.
- If touching shared integration files (`src/index.ts`, `src/ipc.ts`, `src/router.ts`), keep changes minimal and additive.
- If a required file is outside feature ownership, update `feature-catalog.seed.json` first (same change).

### 5. Keep behavior integration explicit

- If a new branch is added, wire it to the existing dispatch/routing path.
- Do not create a second orchestration path for the same feature intent.
- Update inline comments only where control flow is non-obvious.

### 6. Re-check touch-set after edits

```bash
npx tsx .claude/skills/feature-tracking/scripts/check-touch-set.ts "<feature-id-or-query>"
```

### 7. Verify with targeted testing skill

```bash
npx tsx .claude/skills/nanoclaw-testing/scripts/run-feature-tests.ts "<feature-id-or-query>"
```

## Exit Criteria

- Code reuses existing capability where possible.
- No duplicate flow for same behavior.
- Modified files align with feature map (or map updated in same change).
- Typecheck and mapped tests pass.
- Touch-set guard passes before and after implementation.
