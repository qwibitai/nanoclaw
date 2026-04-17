# Triage v1 Rollout Runbook

See the full design at [docs/superpowers/specs/2026-04-16-email-triage-pipeline-design.md](../superpowers/specs/2026-04-16-email-triage-pipeline-design.md).

## Phase 1 — Shadow mode (48h)

1. Set in `.env`:

   ```
   TRIAGE_V1_ENABLED=1
   TRIAGE_SHADOW_MODE=1
   EMAIL_INTEL_TG_CHAT_ID=<group_id>
   ```

   These defaults keep the classifier writing to SQLite and emitting traces but do NOT push to Telegram or invoke knowledge-ingest side effects.

2. Restart NanoClaw:

   ```bash
   # macOS
   launchctl kickstart -k gui/$(id -u)/com.nanoclaw

   # Linux (systemd)
   systemctl --user restart nanoclaw
   ```

3. Verify SSE is flowing and triage is firing:

   ```bash
   sqlite3 data/nanoclaw.db "SELECT queue_placeholder AS _note, confidence, model_tier, datetime(detected_at/1000,'unixepoch') FROM tracked_items WHERE confidence IS NOT NULL ORDER BY detected_at DESC LIMIT 20;"
   ```

   Note: `queue` is not yet a first-class column — infer from `reasons_json` and `action_intent`. A follow-up can add an explicit `queue` column.

4. Tail today's JSONL trace:

   ```bash
   tail -50 .omc/logs/triage/$(date +%Y-%m-%d).jsonl | jq .
   ```

5. Check cache hit ratio (should approach ≥80% after ~1h once the stable prompt blocks warm up):

   ```bash
   jq -s 'map({ci: .cacheReadTokens, in: .inputTokens}) | (map(.ci)|add) / (map(.in)|add)' .omc/logs/triage/$(date +%Y-%m-%d).jsonl
   ```

6. Check today's estimated cost:

   ```bash
   node -e "import('./dist/triage/cost-cap.js').then(m => console.log('$'+m.todayCostUsd().toFixed(4)))"
   ```

7. After 48h, audit the `tracked_items.confidence` distribution, reasons, and tier usage for sanity. Look for:
   - Tier 1 should handle ~85% of calls
   - No unexpected Tier 3 escalations on clearly-archive emails
   - `reasons_json` arrays consistently have ≥2 reasons

## Phase 2 — Live on primary account

1. Flip shadow off:

   ```
   TRIAGE_SHADOW_MODE=0
   ```

   Restart.

2. Watch the `#attention` topic in your email-intel Telegram group for:
   - Per-email push messages with inline buttons (snooze, dismiss, archive, override)
   - The pinned live dashboard editing in place as state changes
3. Use the queue actively. Every archive/dismiss/override click writes to `triage_examples` and eventually promotes senders to the skip-list.
4. Daily 8am PT digest should include the archive dashboard.

## Phase 3 — Bootstrap + extend

1. Bootstrap the skip-list and negative-example set from history (one-off, overnight):

   ```bash
   npm run triage:bootstrap -- --dry-run --limit 500 --account topcoder1@gmail.com
   # Inspect output; if it looks right:
   npm run triage:bootstrap -- --limit 5000 --account topcoder1@gmail.com
   ```

2. After skip-list promotions, the pre-filter should begin short-circuiting more incoming mail — check the fraction of events that skip vs classify in the traces.
3. Enable on secondary accounts by adding their service tokens to `NANOCLAW_SERVICE_TOKEN` (comma-separated) and restarting.

## Rollback

1. Set `TRIAGE_V1_ENABLED=0` in `.env`.
2. Restart.
3. Triage worker stops firing; legacy rule-based `classify()` remains as the only path.
4. Triage columns on `tracked_items` are preserved — nothing is destroyed — so re-enabling later picks up where shadow mode left off.

## Signals to watch weekly

- **Agreement rate:** ≥ 85% on primary account after 14 days. Below 80% on any slice triggers a calibration alert in `#attention`.
- **Cache hit rate:** ≥ 80% steady-state.
- **Daily cost:** < $1 at 100 emails/day. Cap is $2 (overrides trigger a hard stop before the next classifier call).
- **Zero auto-archive incidents** (hard rule, code-enforced).
- **Zero rule violations** bypassed by the model (verifies guardrails work).

## Known limitations (v1)

- SSE payloads currently carry `subject + sender + SP label`, not the full body. The classifier works on this metadata + headers. A follow-up should extend SuperPilot to include the body (or a snippet) in the SSE payload.
- `renderArchiveDashboard` category bucketing uses `action_intent` as a crude proxy; a dedicated `archive_category` column on `tracked_items` would be cleaner.
- `getOpenAttentionItems` uses a heuristic filter (`state IN ('pushed','pending','held') AND (classification='push' OR reasons_json IS NOT NULL)`). When an explicit `queue` column is added, tighten to `queue='attention'`.
- `nextDigestHuman` in the archive dashboard is the literal string `"tomorrow 8am"` — refine once the digest scheduler exposes a next-fire accessor.
- Anthropic Batch API is not used; the bootstrap script makes serial calls with a 200ms delay. Acceptable for a one-off overnight run.
