# Fork Overview

This repository (`trevorWieland/nanoclaw`) is a personal public fork of upstream [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw).

## Fork Philosophy

- Keep core NanoClaw concepts easy to learn.
- Make fork-specific choices explicit instead of implicit.
- Optimize docs for friends/family remixing a personal assistant fork.
- Route substantial product improvements upstream so ecosystem behavior stays aligned.

## Upstream vs This Fork

| Area                                  | Upstream NanoClaw                                 | This Fork                                       |
| ------------------------------------- | ------------------------------------------------- | ----------------------------------------------- |
| Core model                            | Single-process orchestrator + container isolation | Same core model                                 |
| Target audience                       | Broad NanoClaw users                              | Friends/family remixing Trevor's setup          |
| Docs framing                          | Canonical project framing                         | Explicit fork overlays and remix guidance       |
| Contribution target for major changes | Upstream repository                               | Upstream repository                             |
| Contribution target for fork context  | Not applicable                                    | This fork (docs and small personal adjustments) |

## Intentional Divergences in This Fork

- Reader journey docs (`START_HERE`, `FORK_OVERVIEW`, `FORK_SYNC`) are first-class entry points.
- Architecture/spec/security docs include concise `Fork-specific note` callouts where assumptions are local to this implementation.
- Contribution guidance explicitly redirects substantial feature and bugfix work to upstream.

## Who Should Use This Fork

Use this fork if you:

- Want a practical remix base with clear docs for personal use.
- Prefer explicit guidance on what to keep local vs what to upstream.

Use upstream if you:

- Want the canonical source of truth without this fork's personal overlays.
- Plan to contribute substantive platform improvements directly.

## Upstream Relationship

- **Origin** is your personal fork clone.
- **Upstream** remains `qwibitai/nanoclaw`.
- Substantial fixes/features should be proposed upstream first.
- This fork should stay close enough to upstream that sync is routine; see [FORK_SYNC.md](./FORK_SYNC.md).
