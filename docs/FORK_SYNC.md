# Fork Sync Guide

This guide is for non-experts keeping `trevorWieland/nanoclaw` aligned with upstream [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw).

## Mental Model

- `origin` = your fork (for example, `yourname/nanoclaw`)
- `upstream` = canonical project (`qwibitai/nanoclaw`)
- Sync means regularly pulling upstream changes into your fork while preserving your fork-specific docs and local tweaks.

## One-Time Remote Setup

If you forked this repository, configure remotes like this:

```bash
git remote -v
git remote add upstream https://github.com/qwibitai/nanoclaw.git  # if missing
git fetch upstream
```

## Recommended Routine Sync (Main Branch)

```bash
git checkout main
git fetch upstream
git merge upstream/main
```

Then resolve conflicts (if any), run your local checks, and push:

```bash
git push origin main
```

If you prefer linear history, use rebase instead of merge:

```bash
git checkout main
git fetch upstream
git rebase upstream/main
git push --force-with-lease origin main
```

## Conflict Handling for Non-Experts

When merge conflicts happen:

1. Keep upstream behavior for runtime logic unless you intentionally diverged.
2. Preserve this fork's identity docs (`README.md`, `docs/FORK_*`, `docs/START_HERE.md`) where appropriate.
3. Re-check `docs/ARCHITECTURE.md`, `docs/SPEC.md`, and `docs/SECURITY.md` callouts so they still match the code.
4. Re-check `docs/INSTALLATION_MODEL.md` and `ROADMAP.md` for drift when operational behavior changes.

If conflict resolution changes behavior significantly, prefer opening a PR/issue upstream first, then syncing again.

## Practical Workflow for Feature Ideas

1. Validate the idea against upstream direction.
2. Open issue/PR in upstream `qwibitai/nanoclaw` for substantive behavior changes.
3. Keep this fork focused on fork docs, minor personal adjustments, and remix guidance.

## After Every Sync

- Re-read [START_HERE.md](./START_HERE.md) and [FORK_OVERVIEW.md](./FORK_OVERVIEW.md) for drift.
- Confirm [CONTRIBUTING.md](../CONTRIBUTING.md) still reflects upstream-routing policy.
- If major docs are merged/replaced, update [HLD_MIGRATION_MAP.md](./HLD_MIGRATION_MAP.md) (or equivalent mapping doc).
