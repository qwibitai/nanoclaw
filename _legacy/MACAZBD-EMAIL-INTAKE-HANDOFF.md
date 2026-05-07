# Hand-off: macazbd-side workstream email-intake watcher

**SUPERSEDED 2026-05-07.** The architecture got simpler. The current
spec — which you should hand to a Claude session on macazbd — is at
**`MACAZBD-EMAIL-INTAKE-PROMPT.md`** (sibling file). That doc is
written to be pasted directly into an AI harness as a single user
message; it embeds all the topology and contract details below.

## What changed from the original handoff

- Original plan: jibotmac maintains a routes table mapping
  `#ws:<tag>` → a synced workstream folder, then writes the intake
  file directly into `~/switchboard/confidential/<ws>/intake/`.
- New plan: jibotmac drops every `#ws:*` mail into a single inbound
  queue at `~/switchboard/ops/jibot/inbound/email/`. Macazbd scans
  `~/switchboard/confidential/` looking for a folder matching the
  `workstream:` slug in the file's frontmatter, and moves it in.

The new plan is better because:

- New workstreams Just Work the moment macazbd has the folder; no
  jibotmac-side config change.
- Jibotmac doesn't have to know which workstreams are syncthing-
  replicated to it (the previous plan required all routable
  workstreams to be syncthing-shared with jibotmac, which leaks
  topology).
- Single inbound queue → one watcher on macazbd, simpler logging.

See `MACAZBD-EMAIL-INTAKE-PROMPT.md` for the full spec.
