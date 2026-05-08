# Handoff: Build the email channel for NanoClaw 2.0

Saved 2026-05-07 at the end of a long bulk-port session. Pick this up
in a **fresh `claude` session in `~/nanoclaw-merge`**. The Amplifier
remote agent on macazbd is unreliable right now (its `/execute` is
500ing — see `AMPLIFIERD-500-HANDOFF.md`); do this work locally on
jibotmac.

## Goal

Stand up an inbound + outbound email channel adapter so the
`email-joi` and `email-jibot-gidc` agent groups can actually receive
and reply to mail. The agent groups, personas, and container configs
already exist (see `groups/email-joi/` and `groups/email-jibot-gidc/`,
plus `agent_groups` rows in `data/v2.db`). The adapter is the missing
piece — when an email arrives at jibot@ito.com or jibot@gidc.bt, the
host has no channel to receive it through.

This is documented as **Tier-3 deferred** in
`_legacy/PORTING.md` (search for "Tier 3"). Difficulty: high. Crosses
several modules. The cutover plan called this a follow-up project,
not a single-PR thing.

## Two identities, isolated

The two mailboxes are **separate identities, not just aliases**.

|  | jibot@ito.com | jibot@gidc.bt |
|---|---|---|
| Agent group | `email-joi` | `email-jibot-gidc` |
| Workstream | shared / `~/jibrain/` (RW), `~/switchboard/` (RW) | `~/switchboard/confidential/gidc/` only |
| OAuth client | `amplifier-485723` (existing) | `gidc-jibot` (separate Google Cloud project) |
| Amplifier bundle | `amplifier-bundle-joi` | `amplifier-bundle-jibot-gidc` (separate) |
| gog wrapper account flag | `--account jibot@ito.com` | `--account jibot@gidc.bt` |
| Send mode | normal | **pilot mode**: `gog config no-send --account jibot@gidc.bt --enable` is set; drafts saved to Gmail Drafts but never auto-sent. A human reviews. |

The `email-jibot-gidc` persona at `groups/email-jibot-gidc/CLAUDE.local.md`
already states the isolation rules. Keep them. The adapter must wire
the right OAuth account / bundle per messaging_group.

## What 2.0 currently has (the starting point)

- **Channel adapter contract**: `src/channels/adapter.ts`. Read it
  fully — the interface is small (setup / teardown / deliver /
  isConnected / supportsThreads / optional subscribe / openDM).
  Every other channel adapter implements this.
- **Native channel exemplars** to copy patterns from:
  - `src/channels/signal.ts` — long-running daemon (signal-cli)
    that the host talks to over JSON-RPC. The async-poll-and-emit
    pattern is the closest model for an email poller.
  - `src/channels/line.ts` — webhook-style HTTP listener. Useful
    if you go push-notification (Gmail watch).
  - `src/channels/whatsapp.ts` — long-running stateful daemon.
    Heavier than what email needs.
- **Router contract**: `src/router.ts`. The adapter calls
  `setupConfig.onInbound(platformId, threadId, inboundMessage)`
  and the router does the rest (engage / accumulate / drop).
  `platformId` for email should be the canonical address
  (`email:joi@ito.com`, `email:rejon@ito.com`, etc.).
  `threadId` for email is the RFC 5322 thread id (`References:` /
  `In-Reply-To:` chain head).
- **Already in DB**: agent_groups rows for `email-joi` and
  `email-jibot-gidc`, container.json files with persona +
  appropriate mounts. **No** messaging_groups or wirings yet — the
  adapter gives you a place to wire those.
- **Existing tooling**: `~/tools/gog`, `~/tools/gog-run`,
  `~/tools/gog-linux` (mounted into containers RO at
  `/workspace/extra/tools/`). The `gog` CLI handles Gmail/Calendar
  via the Google API. The persona for `email-jibot-gidc` already
  references `gog --account jibot@gidc.bt` for outbound and inbound
  ops. You can use the same tool from the host to poll inbound.

## What 1.x did (the source you're porting from)

`_legacy/v1.2.49/src/email-*.ts` — 14 modules, ~2,400 lines including
tests:

| Module | Lines | Concern |
|---|---|---|
| `email-intake.ts` | 239 | Top-level inbound pipeline orchestrator |
| `email-intake-scheduler.ts` | 49 | Periodic poll loop (fetch new mail every N seconds) |
| `email-intent-resolver.ts` | 141 | Classify message: chat / task / reminder / receipt / etc. |
| `email-identity-resolver.ts` | 94 | Map "From:" → known user_id; uses identity-index.json |
| `email-alias-map.ts` | — | Per-domain alias dictionary |
| `email-address-parser.ts` | — | RFC 5322 / display-name parsing |
| `email-thread-session.ts` | 52 | Thread (Gmail thread id / Message-ID chain) → session id |
| `email-thread-failure-tracker.ts` | 81 | DB-tracked bounce/failure circuit breaker |
| `email-reply-sanitizer.ts` | 54 | Strip quoted reply chains + signatures from outbound |
| `email-attachment-filter.ts` | 72 | MIME-type + size gating before persistence |
| `email-approval-gate.ts` | 99 | Owner approval before sending bot replies via mail |
| `email-policy-adapter.ts` | 54 | Per-channel send policies (pilot mode, no-send, etc.) |
| `email-calendar-adapter.ts` | 103 | Detect calendar invites; defer to `gog calendar` |
| `email-reminder-adapter.ts` | 53 | Detect reminder-style mail; defer to reminder skill |
| `email-receipt.ts` | 89 | Receipt parsing for finance flows |

Each has a `*.test.ts` you can run / port alongside.

## Approach options (pick one or hybrid)

**A. `/add-gmail` skill (recommended starting point).**
Anthropic ships an `/add-gmail` skill in this CLI. Invoke it from
the new session (`/add-gmail`) and it'll guide through OAuth +
scaffold the channel adapter. Then layer 1.x specifics on top.
Trade-off: the skill probably uses Gmail API directly via OAuth,
which is fine for jibot@ito.com but jibot@gidc.bt needs a separate
OAuth client (gidc-jibot in the GIDC GCP project, not
amplifier-485723). The skill may not handle dual-identity
out of the box.

**B. Pure port from `_legacy/v1.2.49/src/email-*.ts`.**
Mechanical translation, file by file. Start with `email-intake.ts`
+ `email-intake-scheduler.ts` (the bones), then layer in the
sub-modules. Keeps the 1.x feature set faithfully but is the most
work. Existing tests give you fast feedback.

**C. Hybrid (probably best).**
Use `/add-gmail` to get OAuth scaffolding + base channel adapter
shell. Port the 1.x intent resolver, identity resolver, reply
sanitizer, and attachment filter from legacy. Build dual-identity
in by reading `agent_groups` (or container.json) to pick the right
OAuth account per inbound. Pilot-mode no-send for jibot-gidc gates
outbound delivery via `gog config no-send`.

I'd start with C.

## Concrete first session plan

1. Read `src/channels/adapter.ts` end-to-end. ~5 min.
2. Read `src/channels/signal.ts` — model for native long-running
   adapter with state. ~10 min.
3. Read `_legacy/v1.2.49/src/email-intake.ts` and
   `email-intake-scheduler.ts` — top-level orchestration. ~10 min.
4. Skim the 1.x identity / intent resolvers. ~5 min.
5. Decide approach (A/B/C above). Spec it briefly to the user
   before writing code; this is a multi-file change.
6. Run `/add-gmail` to set up OAuth for jibot@ito.com (you may
   already have it via gog; check `~/tools/gogcli/`).
7. Build a minimal email channel adapter shell with poll + emit:
   - `src/channels/email.ts`
   - On poll: list new messages via gog, for each call
     `setupConfig.onInbound(platformId, threadId, message)`.
   - On deliver: gog `send` (or pilot-mode draft) the reply.
   - Self-register at module-load time in `src/channels/index.ts`.
8. Wire jibot@ito.com first, end-to-end. Send test mail, watch
   `tail -f /tmp/nanoclaw.stdout.log` for `Email message received`.
9. Layer in jibot@gidc.bt as a second instance with its own OAuth
   account + pilot-mode flag.
10. Port intent resolver / sanitizer / attachment filter as
    follow-ups; the basic adapter works without them, they just
    make replies cleaner.

## Things to double-check before writing code

- The `agent_groups` rows for `email-joi` and `email-jibot-gidc`
  exist already. Don't recreate; just add `messaging_groups` rows
  with `channel_type='email'` and `platform_id='email:<address>'`
  and wire to the existing agent_group_id.
- Container.json for `email-jibot-gidc` mounts
  `confidential/gidc/` RW + jibrain RO + tools RO. Persona is at
  `groups/email-jibot-gidc/CLAUDE.local.md` and explicitly says
  pilot-mode no-send. **Don't break that** — the channel adapter
  must NOT override pilot mode.
- The `/add-gmail` skill in this CLI may want to add new
  dependencies. Check `package.json` afterward; commit them
  separately so the diff is reviewable.
- Mount allowlist (`~/.config/nanoclaw/mount-allowlist.json`)
  permits `~/jibrain` (RW), `~/switchboard` (RW), `~/tools` (RO).
  Anything new will need to be added there.

## Acceptance

Done when:

1. Sending mail to jibot@ito.com triggers an agent run in the
   `email-joi` agent group, with a draft or live reply going back.
2. Sending mail to jibot@gidc.bt triggers a SEPARATE agent run in
   `email-jibot-gidc`, replies are saved as Gmail drafts (no auto-
   send), and the agent never has access to ito.com mailbox.
3. `npm run build` clean. Existing tests pass (`npm test` should
   show ≥571 passing — the baseline). At least the basic poll +
   deliver path has unit tests in
   `src/channels/email.test.ts`.
4. Daemon log shows `Channel adapter started channel="email"`
   on startup.

## Out of scope for this first PR

- ~~Calendar invite detection (defer to `email-calendar-adapter`
  port later).~~ — **landed in `2a11229` (2026-05-06)**; pre-router
  classifies on subject prefixes, `#cal` tag, `calendar-noreply@google.com`
  sender, and `text/calendar` MIME parts → routes to `email:cal` →
  `calendar-watch` agent (`groups/calendar-watch/`).
- ~~Workstream-routing (1.x feature that auto-files mail to the
  right confidential intake based on `To:` / `Cc:` heuristics).~~ —
  **landed in `83b123c` (2026-05-06)**; `#ws:<slug>` tags in subject
  route through `email-dispatch` to per-workstream intake dirs on
  macazbd.
- Reminder detection — still deferred.
- Receipt parsing — still deferred.

The basic chat-style "email comes in, agent responds" flow is the
target. Everything else can layer in later.

## Don't do these things

- Don't unify the two identities into a single agent (data
  isolation matters).
- Don't enable auto-send for jibot@gidc.bt under any circumstance
  unless the user explicitly asks; pilot mode is a hard
  requirement until further notice.
- Don't break existing channels — we have 76 messaging groups
  wired and 55 agents running. The diff should be additive only.
- Don't write to `~/jibrain/intake/` from the email-jibot-gidc
  context. That confidential isolation is non-negotiable.
- Don't push to origin/main without the user's explicit go-ahead;
  the user's been driving the push cadence manually.
