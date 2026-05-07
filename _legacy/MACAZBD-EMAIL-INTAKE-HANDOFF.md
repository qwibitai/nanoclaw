# Hand-off: macazbd-side workstream email-intake watcher

Saved 2026-05-07 from a fresh `claude` session in `~/nanoclaw-merge` on
**jibotmac**. This document specifies what macazbd needs to do to close
the loop on the email-dispatch pipeline.

## Architecture summary (so this doc stands alone)

Two machines:

- **jibotmac** (this host): the I/O layer. Runs the NanoClaw email
  channel because it has the `gog` OAuth keyring for `jibot@ito.com`
  and `jibot@gidc.bt`. Inbound mail with a `#ws:<tag>` in the subject
  is filed locally as a small markdown intake file under
  `~/switchboard/confidential/<ws>/intake/`.
- **macazbd**: Joi's desktop, where the real workstream context lives
  (under the same path on macazbd). More compute, full private state,
  primary identity `joi@ito.com`.

The bridge is **syncthing**, with one folder share per workstream:

| Syncthing folder ID | Path (both hosts) |
|---|---|
| `confidential-gidc` | `~/switchboard/confidential/gidc/` |
| `confidential-gmc` | `~/switchboard/confidential/gmc/` |
| `confidential-jp-ai-agent-startup` | `~/switchboard/confidential/jp-ai-agent-startup/` |
| `confidential-sankosh` | `~/switchboard/confidential/sankosh/` |
| `confidential-wikipedia` | `~/switchboard/confidential/wikipedia/` |

Once jibotmac's email-dispatch agent writes a file into one of those
synced folders' `intake/` subdir, syncthing replicates within ~10s.
**Macazbd needs to watch and act.**

## What jibotmac drops, exactly

Path: `~/switchboard/confidential/<ws>/intake/<ISO-Z>-email-<slug>.md`

Filename:
- ISO 8601 UTC timestamp with `:` replaced by `-` (e.g. `2026-05-07T01-23-45Z`)
- Literal `-email-`
- Kebab-case slug from the subject (with the `#ws:<tag>` removed,
  non-`[a-z0-9-]` stripped, max ~60 chars)
- `.md`

File contents:

```markdown
---
type: email-intake
source: "email:<botAccount>:<senderId>"
author: "<sender display name from From: header>"
subject: "<full subject including the #ws:<tag>>"
workstream: "<tag, lower-cased>"
date: "<ISO-Z timestamp>"
classification: confidential
status: pending
---

<email body, plain text. NOT quote-stripped. NOT signature-pruned.
 Whatever arrived in the latest message of the thread.>
```

Notes:

- `type: email-intake` distinguishes from `type: slack-intake`, `drive-`
  prefixed filenames, etc. Macazbd's watcher should match on `type` to
  know it's an email and route accordingly.
- `status: pending` is the initial state. Macazbd-side processing is
  expected to either move the file to an `_archive/` peer dir on
  completion, or rewrite the frontmatter `status` to `processed` and
  add a `processed_at:` field. **Pick one convention and document it
  in this file** when you implement.
- The intake folder also receives slack-intake, drive-imports, etc.
  Don't assume one source. Filter by `type:` field.

## What macazbd needs to build

A watcher daemon (one per synced workstream, or a single daemon
watching all five paths). On a new file landing in `intake/`:

1. Parse the front-matter. If `type` isn't `email-intake`, skip — some
   other source (slack-intake, manual drop, drive sync) owns it.
2. Trigger the workstream's existing agent / processing pipeline.
   Macazbd already has agent containers and amplifierd; the right
   plumbing is for you to decide.
3. Mark the file processed (move to `_archive/` or update front-matter
   per the convention you pick — see Notes above).
4. Optionally: echo a summary back via whatever channel makes sense
   (a short line in `~/switchboard/ops/jibot/email-intake-log.md`,
   for instance, which is also synced — that gives jibot a confirmation
   trail without ever talking directly to macazbd).

Suggested implementation primitives (pick what suits macazbd's existing
patterns):

- `fswatch` (already on macOS) or `chokidar` for file events
- A small Python or Node script run as a launchd LaunchAgent
- Or, if amplifierd already has a "watch this path → run this agent"
  primitive (it might — check), use that

## What jibotmac promises

- Files only land in `intake/` of folders listed in the routes table.
- Frontmatter is always present and well-formed (the email-dispatch
  agent is constrained to write that shape).
- Filename is unique and ISO-sortable — no need for content-hash dedup.
- `status: pending` is always the initial state; jibotmac never sets
  any other status.
- Bodies are preserved verbatim from the latest email message — no
  pre-processing.

## What jibotmac does NOT promise

- That every `#ws:<tag>` is a routable workstream. Tags not in
  `~/switchboard/config/workstream-routes.json` (synced via the
  `pnhpp-memda` → `~/switchboard/ops/jibot/` share — actually no,
  routes file lives under `~/switchboard/config/`; **add it to a
  syncthing share so macazbd has visibility**) cause the dispatcher
  to reply to Joi asking for clarification, not file anything.
- That macazbd-side processing succeeds. Jibotmac is fire-and-forget.

## Open items for macazbd-side implementer

1. **Pick the post-process convention.** Move-to-archive vs. update-
   front-matter-status. Document it in this file.
2. **Decide if there's a digest / log** of processed emails that
   syncs back to jibotmac. Recommended: a daily-rotated markdown log
   under `~/switchboard/ops/jibot/email-intake-log.md` (already
   syncs via `pnhpp-memda`). Keeps the dispatch operator informed
   without breaking the airgap.
3. ~~**Figure out workstream routes file sync.**~~ **Resolved.** The
   routes file lives at `~/switchboard/ops/jibot/workstream-routes.json`,
   which is already in the `pnhpp-memda` syncthing share. Macazbd has
   visibility — read it there.
4. **New `#ws:` tags.** When Joi wants to add a new workstream:
   - macazbd creates `~/switchboard/confidential/<new-ws>/`
   - Add it to syncthing on both hosts
   - Update `workstream-routes.json` (currently jibotmac-local; see
     item 3 above)
   - Mention to jibot so the email-dispatch agent picks it up on
     next prompt-load
5. **Calendar invites.** A parallel pipeline routes calendar invites
   to a `calendar-watch` agent on jibotmac. That's a separate
   conversation; the macazbd side may not need anything for it.

## Reference: where the jibotmac side lives

- Channel adapter: `src/channels/email.ts` (commit `2a11229` on `main`)
- Pre-router emits `#ws:` mail with `platformId='email:ws-dispatch'`
- Wiring: `mg-email-ws-dispatch` → `email-dispatch` agent_group
- Persona: `groups/email-dispatch/CLAUDE.local.md`
- Bootstrap SQL: `scripts/email-dispatch-bootstrap.sql`
- Routes table: `~/switchboard/ops/jibot/workstream-routes.json` (synced)

## Acceptance

When this is done, end-to-end:

1. Joi mails `Fwd: <something> #ws:gidc` to `jibot@ito.com`
2. Within ~30s (poll interval), email-dispatch agent files an intake
   markdown into `~/switchboard/confidential/gidc/intake/`
3. Within ~10s of that, syncthing has the file on macazbd
4. The macazbd watcher runs the GIDC workstream agent on the file
5. The file ends up archived/processed on the macazbd side; if a
   digest log exists, an entry appears in `~/switchboard/ops/jibot/
   email-intake-log.md` and syncs back
6. Joi sees jibot's brief "Filed under #ws:gidc as <filename>" reply
   in her email thread (with the original mail quoted underneath)

That's the spec.
