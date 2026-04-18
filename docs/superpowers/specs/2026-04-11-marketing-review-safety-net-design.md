# Marketing Review Safety-Net Skill — Design Spec

## Overview

A small NanoClaw skill that acts as a transition-period safety net while `wxa_marketing`'s auto-generated Monthly Review is being trusted. It watches Alexandre's monthly OTE email via the existing `gmail-wxa` MCP, extracts the structured data, posts it to `wxa_marketing`'s external-ingest endpoint, and pings Telegram if the auto-generated numbers diverge from Alexandre's manual numbers.

This is **defensive plumbing**, not a feature. It exists to catch divergence during the period when Alexandre's manual email is still ground truth and `wxa_marketing` is being validated. It is **expected to be retired** after 2-3 clean cycles.

The companion `wxa_marketing` spec is at:
`~/dev/wxa_marketing/docs/superpowers/specs/2026-04-11-portfolio-monthly-review-design.md`

## Design Decisions

- **Type:** Operational skill living in `nanoclaw`. Reuses the existing skill registry, IPC, scheduler, and Telegram channel.
- **Trigger:** Hourly Celery-style poll via the existing `task-scheduler.ts` against the `gmail-wxa` MCP. Looks for new emails matching a fixed filter.
- **Persistence:** Processed message IDs stored in NanoClaw's existing SQLite to prevent reprocessing.
- **Side effect:** POSTs to `wxa_marketing /api/monthly_review/external_ingest`. No other writes.
- **Alerting:** Routes through the existing Telegram channel (per CLAUDE.md, Telegram is the primary channel for email intelligence).
- **Tolerance:** 5% per metric for diff detection. Configurable.
- **Lifecycle:** Designed to be disabled, not deleted. After 2-3 clean cycles, the schedule is set to `disabled: true` in skill config but the code stays in case of regression.

## Data Flow

```
Hourly poll
  ↓
gmail-wxa MCP search_emails: from:alexandre.francois@whoisxmlapi.com subject:"Marketing OTE"
  ↓
For each new message ID not yet processed:
  ↓
gmail-wxa MCP read_email → full body
  ↓
LLM extraction (Claude via container agent) → structured payload:
  {
    period: "2026-03",
    sender: "alexandre.francois@whoisxmlapi.com",
    sheet_url: "...",
    ote_rows: [
      {team_member: "Alexandre François", role: "Marketing & CX & Product", ote_pct: 24.23},
      ...
    ],
    highlights: [{section: "core_metrics", text: "..."}, ...],
    approval_request: true
  }
  ↓
POST to wxa_marketing /api/monthly_review/external_ingest with payload
  ↓
wxa_marketing returns diff result:
  {
    status: "match" | "mismatch" | "missing_internal",
    diffs: [{field: "ote_pct.alexandre", expected: 24.23, actual: 24.18, delta_pct: 0.2}, ...]
  }
  ↓
If status == "match" and all diffs within tolerance: log silently, mark message processed
  ↓
If status == "mismatch": Telegram alert with summary + link to wxa_marketing review draft
  ↓
If status == "missing_internal": Telegram alert "wxa_marketing has no draft for {period}, manual investigation needed"
  ↓
Mark message ID processed in SQLite regardless of outcome
```

## Components

### 1. Skill registration

Self-registers via NanoClaw's existing skill registry pattern at startup. Adds:
- A scheduled task entry (hourly) in `task-scheduler.ts` config
- A new SQLite table `processed_marketing_review_messages(message_id TEXT PRIMARY KEY, processed_at INTEGER, status TEXT)`

### 2. Email poller (`src/skills/marketing-review-safety-net/poller.ts`)

- Calls `gmail-wxa` MCP `search_emails` with the configured query
- For each result, checks SQLite for prior processing
- For unprocessed results, calls `read_email` to fetch the full body
- Hands off to extractor

### 3. Extractor (`src/skills/marketing-review-safety-net/extractor.ts`)

Sends the email body to a small Claude container agent with a fixed extraction prompt. The prompt is brittle on purpose — it expects Alexandre's exact format and refuses to guess if the format changes. Returns the structured payload above or an `extraction_failed` result.

If extraction fails, sends a Telegram alert: "Alexandre's email format may have changed, manual review needed" with a link to the message in Gmail.

### 4. Diff client (`src/skills/marketing-review-safety-net/diff-client.ts`)

Posts the extracted payload to `wxa_marketing /api/monthly_review/external_ingest`. Receives the diff result. Returns it for routing.

### 5. Alert router (`src/skills/marketing-review-safety-net/alerter.ts`)

Routes Telegram alerts based on diff result. Messages are short and actionable:

- **Mismatch alert:** "📊 WXA Marketing Review diff for 2026-03: Alexandre's OTE for X says 24.23%, wxa_marketing computed 22.87% (delta 5.6%, exceeds 5% tolerance). Review draft: <link>"
- **Missing internal alert:** "⚠️ wxa_marketing has no draft for 2026-03 but Alexandre's email arrived. Investigate Celery job."
- **Format change alert:** "⚠️ Could not extract structured data from Alexandre's email — format may have changed. <gmail link>"
- **No alert** for clean matches (logged only).

## API Contract with wxa_marketing

### Request

```
POST /api/monthly_review/external_ingest
Content-Type: application/json
Authorization: Bearer <internal-shared-secret>

{
  "brand_id": "wxa",
  "source": "alexandre_email",
  "period": "2026-03",
  "raw_payload": {
    "sheet_url": "...",
    "ote_rows": [...],
    "highlights": [...],
    "approval_request": true
  }
}
```

### Response

```json
{
  "status": "match" | "mismatch" | "missing_internal" | "extraction_invalid",
  "internal_review_id": "uuid-or-null",
  "diffs": [
    {"field": "ote_pct.alexandre_francois", "external": 24.23, "internal": 22.87, "delta_pct": 5.6, "exceeds_tolerance": true},
    ...
  ],
  "tolerance_pct": 5.0,
  "review_url": "https://marketing-center.../reviews/<id>"
}
```

The shared secret is stored in NanoClaw's existing OneCLI / `.env` system (variable `WXA_MARKETING_INGEST_SECRET`).

## Configuration

Lives in skill config (YAML), per the existing skill pattern:

```yaml
marketing_review_safety_net:
  enabled: true
  poll_interval_minutes: 60
  gmail_query: 'from:alexandre.francois@whoisxmlapi.com subject:"Marketing OTE"'
  brand_id: "wxa"
  ingest_url: "https://marketing-center.internal/api/monthly_review/external_ingest"
  ingest_secret_env_var: "WXA_MARKETING_INGEST_SECRET"
  telegram_alert_channel: "primary"
  retired: false  # set to true after 2-3 clean cycles
```

## Error Handling

- **gmail-wxa MCP unreachable** — log + skip cycle, no alert (transient errors are noisy). After 6 consecutive failures, send one Telegram alert.
- **Extraction LLM fails** — Telegram alert with Gmail link, mark message as `extraction_failed` in SQLite to prevent retry storms. Manual rerun command exists to retry.
- **wxa_marketing endpoint unreachable** — log + retry with exponential backoff up to 1 hour, then Telegram alert.
- **wxa_marketing returns 5xx** — same as unreachable.
- **wxa_marketing returns 4xx** — Telegram alert (this is a contract bug, not a transient error).

## Testing

- **Unit tests** for the extractor against fixture emails (Alexandre's last 3 months).
- **Mock wxa_marketing** for diff-client tests using NanoClaw's existing mock pattern (this caught the recent container-runner test mock bug per recent commit `12a970d`).
- **Manual end-to-end test** during week 8 of the wxa_marketing rollout: Alexandre's real email → real `gmail-wxa` MCP → real extraction → real ingest endpoint → assert Telegram alert content.

## Retirement Criteria

The skill is set to `retired: true` (disabled but not deleted) when:

1. 2-3 consecutive months of clean matches (all diffs within tolerance, no extraction failures, no missing-internal alerts)
2. Alexandre confirms `wxa_marketing`'s auto-generated report is good enough to replace his manual email

After retirement, Alexandre stops sending the manual email and `wxa_marketing`'s scheduled monthly Celery job becomes the source of truth. The skill code stays in the repo as documentation and as a re-enable option if regressions appear.

## What This Spec Does Not Cover

- Acting on the email beyond extraction + diff (no auto-approve, no auto-forward to HR)
- Multi-tenant support (only WXA — this is a transition-period safety net for one anchor tenant, not generic infrastructure)
- Replacing the existing email-trigger acknowledgment work (recent commit `c0d1bb4`) — this is additive, separate flow
- Alerts to non-Telegram channels
