# Prompt for the Claude session on macazbd

> **How to use this:** open a Claude Code (or amplifier) session on
> macazbd in whatever working directory makes sense for ops scripts
> there. Paste everything below the line as a single user message.
> Claude will read the existing topology, propose an implementation,
> and (with your approval) build it.

---

I need you to build a small watcher on this machine (**macazbd**, my
desktop) that picks up email intake files dropped by the jibot bot
running on **jibotmac**. The two hosts are bridged by syncthing.
Workstream confidential folders live here on macazbd; jibotmac only
sees a syncthing-replicated subset and deliberately doesn't know what
each workstream is for.

## Background — jibotmac side (already built)

jibotmac runs a NanoClaw email channel. When mail arrives at
`jibot@ito.com` with `#ws:<tag>` in the subject, a small dispatcher
agent there writes a markdown intake file into the synced folder
`~/switchboard/ops/jibot/inbound/email/`. That folder is in the
`pnhpp-memda` syncthing share, so on this machine it's at the same
path: `~/switchboard/ops/jibot/inbound/email/`.

Files land within ~10s of the email arriving on jibotmac.

## What each intake file looks like

Filename: `<ISO-Z timestamp>-<workstream-tag>-<short-subject-slug>.md`,
e.g. `2026-05-07T01-23-45Z-gidc-quarterly-update.md`. Sortable.

Contents:

```markdown
---
type: email-intake
source: "email:jibot@ito.com:joi@ito.com"
author: "Joi Ito"
subject: "Fwd: Q1 financials #ws:gidc"
workstream: "gidc"
date: "2026-05-07T01:23:45.000Z"
classification: confidential
status: pending
---

<full email body, plain text, preserved verbatim from the latest
 message in the Gmail thread — not quote-stripped, not signature-
 trimmed>
```

The contract from jibotmac:

- `type: email-intake` always
- `workstream` is always lower-cased and matches `[a-z0-9_-]+`
- `status: pending` always (initial state)
- Filename is unique and ISO-sortable; no need for content-hash dedup
- Body is verbatim — your call what to do with quoted-reply chains

## What you should build

A **per-host watcher** that picks up files from
`~/switchboard/ops/jibot/inbound/email/` and dispatches them by the
`workstream:` field.

**Routing rule (this is the heart of the design):**

For each new file with `type: email-intake`:
1. Read the `workstream:` field.
2. Look for a folder at `~/switchboard/confidential/<workstream>/` —
   case-insensitive slug match. If you see exactly one match, that's
   the destination workstream. If you see zero or multiple, treat it
   as unrouted (see below).
3. **Move** the intake file to
   `~/switchboard/confidential/<workstream>/intake/<original-filename>`.
   Create the `intake/` subfolder if it doesn't exist.
4. Whatever workstream agent / processing you have for that folder
   takes it from there. (You may already have processing for some
   workstreams; if not, "moved into intake/" is the end state and
   the folder owner deals with it manually for now.)

**Unrouted handling (slug doesn't match a folder):**
- Move the file to `~/switchboard/ops/jibot/inbound/email/_unrouted/`
  (create that subfolder).
- Append a one-line entry to
  `~/switchboard/ops/jibot/email-intake-log.md` so jibotmac (which
  also sees that file via syncthing) has a trail. Format:

      - 2026-05-07T01:23:50Z UNROUTED workstream=foo file=2026-05-07T01-23-45Z-foo-quarterly-update.md

  This log is the only feedback channel back to jibot — keep it tight.

**Successful-route logging:**
- Same file. One line per dispatch:

      - 2026-05-07T01:23:50Z ROUTED workstream=gidc file=2026-05-07T01-23-45Z-gidc-quarterly-update.md

## Implementation choices (you pick — don't ask me before doing it)

Pick whatever fits macazbd's existing patterns. Some reasonable
options:

- A `launchd` LaunchAgent running a Python or Node script with
  `fswatch` / `chokidar` watching the inbound folder. One-shot per
  file event; idempotent re-runs OK.
- A periodic cron / launchd-on-interval that scans the folder every
  ~15s and processes anything pending.
- If macazbd already has an amplifierd primitive for "watch this
  path → run this thing", use it.

Whatever you pick, make sure:
- Failures are loud (log to `email-intake-log.md` with `ERROR` so
  jibotmac can see it).
- The script is idempotent — re-running on the same file is a no-op
  if it's already been moved.
- A launchd config (or equivalent) keeps it running across reboots.

## What's already there to inspect

Before you write code, take a look:

1. `ls ~/switchboard/ops/jibot/inbound/email/` — does the folder
   exist? Are there any files queued up?
2. `ls ~/switchboard/confidential/` — what workstream folders are
   present here? (jibotmac only has 5: `gidc`, `gmc`,
   `jp-ai-agent-startup`, `sankosh`, `wikipedia`. Macazbd may have
   many more.)
3. `ls ~/switchboard/ops/jibot/email-intake-log.md` — does it exist
   yet? (If not, your watcher creates it on first dispatch.)
4. Check for existing launchd agents: `ls ~/Library/LaunchAgents/`
   and `launchctl list | grep -i intake` — is anything similar
   already running?
5. Check for existing watcher scripts: `find ~/switchboard ~/scripts
   ~/bin -name '*intake*' -o -name '*watch*' 2>/dev/null` —
   especially anything from the 1.x era that might've handled a
   similar pipeline.

If you find existing infrastructure that does roughly this for
slack-intake or drive-intake or anything else, **read its shape
before inventing a new pattern**. The macazbd-side has had agent
plumbing for a while; reuse beats reinvention.

## Acceptance criteria

When you report back, I want to be able to:

1. Send `Fwd: <thing> #ws:gidc` to `jibot@ito.com`
2. Within ~30-60s see a new file appear in
   `~/switchboard/confidential/gidc/intake/`
3. See an `email-intake-log.md` line confirming the dispatch
4. Send `Fwd: <thing> #ws:somethingfake` and see an `UNROUTED` entry
   plus the file in `_unrouted/` (no errors)

## Things I do NOT want

- Don't reach across the sync to jibotmac's side — your watcher
  should only read paths under `~/switchboard/` on this host.
- Don't try to "improve" the intake file format or the routing rule.
  The contract above is what jibotmac writes; that's the boundary.
  If you think it should change, propose it back to me, don't
  unilaterally diverge.
- Don't auto-respond to Joi via email. The reply happens on
  jibotmac's side; macazbd is silent except via the log file.
- Don't move files out of `~/switchboard/ops/jibot/inbound/email/`
  if they're missing required frontmatter — leave them in place
  and write an `ERROR` line in the log so it's debuggable.

When you're done, append a section to this file (or write a sibling
`MACAZBD-EMAIL-INTAKE-IMPLEMENTATION.md`) describing what you built,
where it lives, and how to debug it — that doc itself can ride
syncthing back to jibotmac so the loop is documented end-to-end.
