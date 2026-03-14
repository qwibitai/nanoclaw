# ADR-001: Private Group Data via Git Submodules

**Date:** 2026-03-14
**Status:** Accepted

## Context

NanoClaw is forked from an upstream repo and must remain public to pull upstream changes. However, agent groups (`groups/`) contain PII — agent memory files, notes, shopping lists, and other user data written by the agents at runtime.

Previously, only `CLAUDE.md` files in `groups/main/` and `groups/global/` were tracked in the public repo, with everything else gitignored. This meant group data had no version control or backup.

## Decision

Each group directory is a **private GitHub repository** added as a **git submodule** in the public repo.

- Naming convention: `nanoclaw-group-<group-name>` (e.g. `mlwynne24/nanoclaw-group-main`)
- The parent repo's `.gitignore` has `groups/*` which catches any new group directories that haven't been registered as submodules yet, preventing accidental PII exposure
- Submodules override `.gitignore` — once registered via `git submodule add -f`, they are tracked regardless of ignore rules
- Each submodule has its own `.gitignore` excluding core dumps (`core.*`) and logs

## How to add a new group as a submodule

```bash
# 1. Create private repo
gh repo create mlwynne24/nanoclaw-group-<name> --private

# 2. Initialize and push group data
cd groups/<name>
git init
echo -e "core.*\nlogs/\n*.log" > .gitignore
git add -A && git commit -m "Initial commit"
git remote add origin git@github.com:mlwynne24/nanoclaw-group-<name>.git
git branch -M main && git push -u origin main

# 3. Remove folder, add as submodule (from repo root)
cd ../..
cp -a groups/<name> /tmp/nanoclaw-backup-<name>
rm -rf groups/<name>
git submodule add -f git@github.com:mlwynne24/nanoclaw-group-<name>.git groups/<name>
cp -rn /tmp/nanoclaw-backup-<name>/* groups/<name>/
```

## Daily sync

A scheduled task can push each submodule's changes daily:

```bash
for dir in groups/*/; do
  (cd "$dir" && git add -A && git diff --cached --quiet || git commit -m "Auto-sync $(date +%Y-%m-%d)" && git push)
done
```

## Consequences

- Group data is version-controlled and backed up privately
- The public repo contains only submodule pointers (commit SHAs), not actual content
- New groups are safely gitignored until explicitly registered as submodules
- Upstream pulls are unaffected — upstream doesn't have these submodules
