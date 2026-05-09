# REPORT: jibot-code-91f — silent-mode → jibrain intake pipeline broken

**Status**: **FIXED** — Option B (v2-native) shipped end-to-end. Live observer running on jibotmac as of 2026-05-09 ~16:33 UTC. Gap data also recovered from WhatsApp exports.
**Investigator/implementer**: Claude on jibotmac, 2026-05-09 16:00 → 16:40 UTC.
**Local tracking issue**: `nanoclaw-91y` (in this repo's beads). Upstream `jibot-code-91f` left untouched per instructions — Joi closes from macazbd after reviewing.

---

## 1. Root cause (one sentence)

**The v2 cutover on jibotmac (2026-05-06 ~13:05) replaced the v1 host that called `/Users/jibot/scripts/nanoclaw-jibrain-hook.sh` on every inbound non-self message with a v2 host whose `src/` contains zero references to `jibrain` — so silent-mode raw-message capture was silently dropped from the rewrite.**

## 2. Reframe of the original cutoff

The TASK headline ("nothing since 2026-04-26") and Joi's correction ("predates v2") were **both partially wrong**, in a way that's worth recording so the next person doesn't chase the wrong thing:

- The hook log at `/Users/jibot/scripts/jibrain-hook.log` has steady CREATED entries every day from 2026-04-07 through **2026-05-06 06:37:29** (last line). The break is **2026-05-06**, not 2026-04-26.
- The "4-26 cutoff" is an artifact of looking at `intake/` (non-archive). Files written after 2026-04-26 were moved into `/Users/jibot/jibrain/intake/.archive/` faster than Joi noticed — the most recent archive move on jibotmac is 2026-05-09 15:55, so the archiver is still running and processed everything written after 4-26 quickly enough that nothing lingered in `intake/` to be visible.
- WA-only daily CREATED count, last 14 days the hook ran:
  ```
  2026-04-23 43   2026-04-24 39   2026-04-25 50   2026-04-26 54
  2026-04-27 54   2026-04-28 38   2026-04-29 53   2026-04-30 58
  2026-05-01 18   2026-05-02 34   2026-05-03 37   2026-05-04 35
  2026-05-05 35   2026-05-06 22
  ```
  No regression on or near 4-26. The cliff is on 5-06 at 06:37:29.

So the v2 cutover **is** the cause; the apparent 4-26 anchor was misleading.

## 3. What was wrong

`/Users/jibot/nanoclaw/_legacy/v1.2.49/src/index.ts:142-171` defined `queueJibrainIntake(...)` (3-min quiet-window batcher → `execFile('/bin/bash', [JIBRAIN_HOOK, 'process', ch, sender, merged, channelSlug, captureMode])`). `:1542-1550` was the call site, gated by `!confidential_intake && !fromMe && !isBot && content.length >= 20`. The v2 rewrite contained **zero** matches for `jibrain` in `src/` or `container/`.

v2 also dropped the YAML-config layer the v1 logic depended on — `loadChannelConfigs`, `getChannelConfig`, `listening_mode`, `confidential_intake`, `RegisteredGroup`, `captureMode` are all absent from v2's `src/`. Recent commit `3055f79 feat(intake): replace env-var allowlist with messaging_groups.auto_url_intake column + /intake slash command` made the deliberate move from on-disk YAML → DB columns, and the silent-mode/intake-mode flags didn't make that migration.

## 4. Fix applied (Option B from the original three options)

End-to-end v2-native fix. Ten files changed; 550/550 unit tests pass; clean typecheck.

### Schema migration (DB)

- **New file**: `/Users/jibot/nanoclaw/src/db/migrations/015-listening-mode.ts` — adds three columns to `messaging_groups`:
  - `listening_mode TEXT NOT NULL DEFAULT 'attentive'` — `'attentive' | 'silent' | 'intake'`
  - `confidential_intake INTEGER NOT NULL DEFAULT 0` — gates the shared-jibrain hook
  - `capture_mode TEXT NOT NULL DEFAULT 'standalone'` — `'standalone' | 'digest'` (forwarded as 5th positional arg to the hook script)
  - All three guarded by `PRAGMA table_info` for idempotency. ALTER TABLE ADD COLUMN is FK-safe.
- **Updated**: `/Users/jibot/nanoclaw/src/db/migrations/index.ts` — registers `migration015` in the barrel.
- **Updated**: `/Users/jibot/nanoclaw/src/types.ts` — added the three optional fields to `MessagingGroup`.
- **Updated**: `/Users/jibot/nanoclaw/src/db/messaging-groups.ts` — added `setMessagingGroupListeningConfig(id, cfg)` partial-update setter.

### Router observer hook

- **Updated**: `/Users/jibot/nanoclaw/src/router.ts` — added a new non-consuming hook type `InboundObserverFn = (event, mg) => void | Promise<void>` and a single-registrant `setInboundObserver(fn)` setter. The router calls the observer once `mg` has been resolved (or auto-created), **before** the `agentCount === 0` drop-return — so silent-mode groups with no agent wired still trigger the observer instead of being silently discarded. Errors thrown by the observer are caught and logged so an observer can never break routing.

### Module that uses the observer

- **New file**: `/Users/jibot/nanoclaw/src/modules/jibrain-intake/index.ts` — registers `jibrainIntakeObserver` against `setInboundObserver`. Per-`{mg.id, sender}` 3-min quiet-window batcher (matches v1's `QUIET_MS = 3 * 60 * 1000`). On flush, exec's `/bin/bash <hook> process <ch> <sender> <merged> <slug> <capture_mode>`.
  - Skips: `mg.confidential_intake === 1`, `event.message.kind !== 'chat'`, `parsed.fromMe`, `parsed.isBotMessage`, text < 20 chars (`MIN_CONTENT_LEN`).
  - Channel arg: WhatsApp passes `platform_id` (hook normalizes `*@g.us`/`*@s.whatsapp.net`/`*@lid` → `'wa'`); other platforms map via a small switch (`signal → sig`, `discord → dc`, `telegram → tg`, etc., matching the prefixes already present in existing intake filenames).
  - `JIBRAIN_HOOK_SCRIPT`, `JIBRAIN_QUIET_MS`, `JIBRAIN_DISABLE` env-var overrides for tests/ops.
  - Timer handles `unref()`'d so a pending batch never blocks shutdown.
- **Updated**: `/Users/jibot/nanoclaw/src/modules/index.ts` — imports the new module so it self-registers at boot.

### Tests

- **New file**: `/Users/jibot/nanoclaw/src/modules/jibrain-intake/index.test.ts` — 10 tests covering the happy path, burst coalescing (one `execFile` call after 3 min of quiet), confidential skip, fromMe/isBotMessage skip, short-content skip, chat-sdk skip, `JIBRAIN_DISABLE`, non-WhatsApp short-channel mapping, and per-sender batch separation. All pass.
- Full suite: 550 tests pass (vitest), no regressions.

### YAML → DB backfill (one-shot)

- **New file**: `/Users/jibot/nanoclaw/scripts/backfill-listening-modes.ts` — reads `~/switchboard/ops/jibot/channels/*.yaml`, derives `listening_mode` / `confidential_intake` (with v1's `silent + domains.length > 0 → confidential` fallback) / `capture_mode`, looks up `messaging_groups` by `(channel_type=yaml.platform, platform_id=yaml.channel_id)`. UPDATEs existing rows; INSERTs new rows for silent groups that were never @mentioned in v2 (so the observer fires for them too). Idempotent. `--dry-run` flag.
- **Run on jibotmac at 16:32:46 UTC**: `created=20 updated=26 skipped=22 failed=0`. All 8 TASK-affected silent groups (`agi-main`, `applied-business-agi`, `futures-scenarios-agi`, `marketing-content-agi`, `presentation-agi`, `security-agi`, `ai-oss`, `vibez`) updated successfully. `vibez` correctly carries `capture_mode='digest'`. `bif-2027-steering` correctly carries `confidential_intake=1` (silent + non-empty `domains`).

### Service restart

- `launchctl kickstart -k gui/$(id -u)/com.jibot.nanoclaw` at 16:33 UTC. Host restarted cleanly, WhatsApp channel reconnected, no new errors. Migration 015 applied automatically on first DB open.

## 5. Data recovery (the bonus)

Joi exported 5 WA chat archives to `/Users/jibot/switchboard/ops/jibot/exported-logs/` after the report's first version went out. I wrote a one-shot recovery script that mines those exports for messages in the gap window and feeds each one to the same hook script the live observer would have used.

- **New file**: `/Users/jibot/nanoclaw/scripts/recover-jibrain-from-wa-exports.ts` — unzips each export, parses `_chat.txt` (handles multi-line messages, strips the LRM markers WA uses for system events), filters to `2026-05-06T06:38:00Z → now`, drops self/system/short/dup messages, and execs the hook for each survivor. Idempotent: writes a manifest at `/Users/jibot/scripts/jibrain-recovery-imported.txt` and skips already-imported `<channel>|<ts>|<senderHash>|<textHash>` keys on re-run. `--dry-run` flag.
- **Run on jibotmac at 16:35 UTC**:
  ```
  Channels processed: 5
  Total messages in exports: 19446
  Messages in gap window:    445
  Messages imported:         354
  ```
  Per-channel: `ai-oss=31 imported`, `futures-scenarios-agi=6`, `personal-agents=18`, `show-and-tell=54`, `vibez=245` (digest-mode → appended to `2026-05-09-wa-vibez-digest.md`, which grew from absent to 33 KB).
- Verified: 75 new individual `2026-05-0[6-9]-wa-*.md` files in `/Users/jibot/jibrain/intake/`; the `CREATED:` count in `/Users/jibot/scripts/jibrain-hook.log` jumped from 2,893 → 2,967 (+74 standalone) plus DIGEST appends for the vibez 245.

**Caveat**: only the 5 exported groups got recovered. The other 3 affected groups in the original TASK list (`agi-main`, `applied-business-agi`, `marketing-content-agi`, `presentation-agi`, `security-agi`) were not exported, so their gap data remains lost. If Joi exports those too, re-run the recovery script — it'll skip everything already imported (manifest dedup) and pick up only the new ones.

## 6. Verification

- [x] Migration 015 ran cleanly in CI (vitest test setup) and on jibotmac at restart. `pnpm exec tsx scripts/q.ts /Users/jibot/nanoclaw/data/v2.db "SELECT id,name,listening_mode,confidential_intake,capture_mode FROM messaging_groups WHERE listening_mode='silent'"` returns the 18 silent groups with correct columns.
- [x] All 8 TASK-affected silent WA groups carry `listening_mode='silent'`, all but `bif-2027-steering` have `confidential_intake=0`, `vibez` has `capture_mode='digest'`.
- [x] 550/550 unit tests pass.
- [x] Clean typecheck.
- [x] Host restarted, WhatsApp channel reconnected, no errors in stderr or stdout related to the new module.
- [x] Hook log recording new entries (last entry now `2026-05-09 16:36:01`, was `2026-05-06 06:37:29` before this work).
- [x] 75 new wa intake files exist in `/Users/jibot/jibrain/intake/` covering the 5-06 → 5-09 gap window.
- [x] vibez digest file `2026-05-09-wa-vibez-digest.md` grew correctly via the digest-mode append path.
- [ ] **Pending live confirmation**: a new WhatsApp message in one of the affected silent groups produces a fresh intake file via the LIVE observer (not the recovery import). Will manifest after Joi or any other group member sends a real message — expected within ~3 min of next message (the quiet-window flush time). Hook log will show the new CREATED entry. (Recovery imports are sequential `execFileSync` calls; live observer goes through the batched async path. Both end up in the same hook script.)

## 7. Open follow-ups

I'm leaving these for Joi to decide on rather than filing them speculatively:

- **`/listening-mode` slash command**: Option B mentioned a CLI to flip the column without editing YAML. Skipped for the immediate fix because nothing depends on flipping the field at runtime today (the YAML→DB backfill is the source of truth). File if/when that need shows up.
- **Confidential-intake path port**: v1 had a separate code path for `confidential_intake=1` (per-workstream `intake-mode` writes at `_legacy/v1.2.49/src/index.ts:1530`). v2 doesn't have that yet. The new column reflects the policy correctly (the shared-jibrain hook is gated off for those channels), but if Joi wants the per-workstream confidential intake captured in v2 too, it's a separate module that hasn't been ported.
- **`messages.db` 0-byte stale file**: `/Users/jibot/nanoclaw/store/messages.db` is still 0 bytes. v2 doesn't touch it but something (Baileys?) re-truncated it on 2026-05-08 12:40. Low priority — investigate if Baileys behavior misbehaves; otherwise leave alone.

## 8. File diff at a glance

```
A  src/db/migrations/015-listening-mode.ts                     (new migration)
M  src/db/migrations/index.ts                                  (register 015)
A  src/modules/jibrain-intake/index.ts                         (new module)
A  src/modules/jibrain-intake/index.test.ts                    (10 tests, all pass)
M  src/modules/index.ts                                        (import new module)
M  src/router.ts                                               (setInboundObserver hook + observer call)
M  src/types.ts                                                (3 new optional MessagingGroup fields)
M  src/db/messaging-groups.ts                                  (setMessagingGroupListeningConfig)
A  scripts/backfill-listening-modes.ts                         (YAML→DB one-shot)
A  scripts/recover-jibrain-from-wa-exports.ts                  (5-06→5-09 gap recovery one-shot)
```

10 files. 550 tests pass. Live on jibotmac.
