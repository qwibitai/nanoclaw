# HLD Migration Map

This file maps content from the retired `nanoclaw-hld.md` into canonical docs so information remains traceable.

## Status

- Source doc: `nanoclaw-hld.md`
- Migration target: canonical docs listed below
- Retirement intent: delete source HLD after this map and destination docs stay current

## Section Mapping

| HLD Section                                                                                | Canonical Destination                                                                                                                                   | Notes                                                                |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| What This Is / Why You'd Want This / Who This Fork Is For                                  | `README.md` (`About This Fork`, `What This Fork Adds`), `docs/FORK_OVERVIEW.md`                                                                         | Positioning kept concise; operational claims moved to technical docs |
| How NanoClaw Works (core loop, groups, global identity, isolation rationale)               | `README.md` (`Architecture`), `docs/SPEC.md` (`Architecture`, `Message Flow`, `Memory System`), `docs/ARCHITECTURE.md` (identity and multi-group model) | Runtime behavior anchored in SPEC                                    |
| Production Resilience (circuit breaker, auto-pause, dedup, token priority, admin commands) | `README.md` (`What This Fork Adds`), `docs/SPEC.md` (`Commands`, `Scheduled Tasks`, `Claude Authentication`), `docs/SECURITY.md`                        | Security and auth boundaries kept in SECURITY                        |
| Multi-Group Architecture (main, architect, additional groups)                              | `docs/ARCHITECTURE.md`, `docs/SPEC.md`                                                                                                                  | Includes coordinator/non-main boundaries and responsibilities        |
| Tanren Integration / worker-manager IPC model                                              | `docs/ARCHITECTURE.md` (code orchestration supervisor), `docs/INSTALLATION_MODEL.md`                                                                    | Treated as optional operating pattern                                |
| Modernized Toolchain                                                                       | `AGENTS.md`, `README.md`, `package.json` scripts                                                                                                        | Commands remain canonical in repo scripts                            |
| Container Security Hardening                                                               | `docs/SECURITY.md`, `docs/SPEC.md` (security considerations)                                                                                            | Covers mount validation, IPC auth, credential proxy                  |
| Setting Up Your Own Installation (code vs config separation)                               | `docs/INSTALLATION_MODEL.md`, linked from `README.md` and `docs/START_HERE.md`                                                                          | Includes sample directory layout and group model                     |
| Household Meal Planning Example                                                            | `docs/INSTALLATION_MODEL.md`                                                                                                                            | Preserved as group pattern example, not product requirement          |
| Credential Management (current/future deployment models)                                   | `docs/SECURITY.md` (current model), `ROADMAP.md` (future centralized model)                                                                             | Current behavior aligned to credential proxy implementation          |
| Extending NanoClaw (add group/tool/task/channel)                                           | `README.md` (`Extending`), `docs/SPEC.md` (channels, tasks, MCP)                                                                                        | Implementation details stay in SPEC                                  |
| Comparison to Other Approaches                                                             | `docs/FORK_OVERVIEW.md`                                                                                                                                 | Kept high-level and non-normative                                    |
| Fork Maintenance Philosophy (upstream relationship, fork vs private config)                | `CONTRIBUTING.md`, `docs/FORK_SYNC.md`, `docs/INSTALLATION_MODEL.md`                                                                                    | Clarifies where to upstream vs keep local                            |
| Roadmap                                                                                    | `ROADMAP.md`                                                                                                                                            | Tracks implemented/planned/exploratory items with dates              |

## Maintenance Rule

When retiring another major document, add an equivalent mapping table before deletion.
