---
name: linkedin-ads
description: "LinkedIn Ads playbooks for performance, creative audits, launches, and cross-account compare. Lives in the Ads agent group. Triggers on /linkedin-ads-*, 'pull linkedin ads performance', 'audit linkedin creatives', 'launch linkedin campaign'."
---

# LinkedIn Ads

LinkedIn-specific playbooks that turn the `mcp__linkedinAds__*` tools into concrete sub-commands. Lives in the Ads agent group.

This skill assumes:
- You are running inside the Ads agent group (where `linkedinAds` MCP server is wired via `container.json`).
- Client → account mapping is in `/workspace/agent/ad-accounts.json`.
- Group context lives at `/workspace/agent/CLAUDE.local.md`.

## Always remember (LinkedIn-specific gotchas)

1. **`landing_page_clicks` vs `clicks`.** Most LinkedIn "clicks" are social engagements (like, comment, share, follow, profile-view), NOT website visits. `landing_page_clicks` is the only real website-traffic metric. CPL must use `landing_page_clicks` as the denominator, not `clicks`. Always call out the distinction in any CTR/CPC/CPL reported.
2. **BCG RISE / LinkedIn:** flag when `landing_page_clicks / clicks < 5%` — that's the signal Brad uses to know clicks are mostly engagement, not traffic.
3. **Two BCG RISE accounts:** `514553139` (RfB — RISE for Business) and `514555066` (Rise 2.0). Don't merge them silently — pull each and label.
4. **Cache and Meadow are both fintech** — viable cross-account benchmarks.

## Client → LinkedIn account ID (quick lookup)

| Client | LinkedIn account_id | Notes |
|---|---|---|
| Cache Financials | `508840163` | "Cache Ad Account" |
| BCG RISE — RfB | `514553139` | "RISE for Business" |
| BCG RISE — Rise 2.0 | `514555066` | "Rise 2.0" |
| CADCo | — | No LinkedIn account |

If the user names a client not in this table, read `/workspace/agent/ad-accounts.json` and resolve from there. If the client has no `linkedin_ads` mapping, say so and stop.

---

## Sub-command: `/linkedin-ads-performance <client>`

Pull 7d and 30d performance for the client's LinkedIn account(s).

**Steps:**

1. Resolve `<client>` to one or more `account_id`s from `/workspace/agent/ad-accounts.json`. If client has multiple (e.g. BCG RISE), run the flow for each and label outputs.
2. `mcp__linkedinAds__list_campaigns` with the account_id → cache the campaign id → name + status map.
3. `mcp__linkedinAds__get_campaign_performance` for the account, date range = last 7 days. Request fields: `impressions`, `clicks`, `landing_page_clicks`, `cost_in_usd` (or local currency field as exposed), `external_website_conversions` / leadgen submissions where applicable.
4. Repeat step 3 with date range = last 30 days.
5. If campaigns include lead-gen objective: `mcp__linkedinAds__get_lead_gen_performance` for the same windows.
6. Format as two side-by-side tables (7d, 30d):

   | Campaign | Spend | Impr | Clicks | LP Clicks | LP% | CPC* | CPM | CTR* | Leads | CPL** |
   |---|---|---|---|---|---|---|---|---|---|---|

   `*` = computed against `landing_page_clicks`, not `clicks` (footnote: "LinkedIn 'clicks' include social engagements; we report CPC/CTR against landing_page_clicks for true-website-traffic intent")
   `**` = `spend / lead_form_submissions` if leadgen; else `spend / landing_page_clicks` for "cost per visit"

7. Anomaly callouts (flag any of):
   - CTR (vs LP clicks) < 0.4%
   - CPC (vs LP clicks) > $15 (or > 3× the client's trailing 30d average)
   - `landing_page_clicks / clicks < 5%` → "clicks are mostly engagements, not traffic"
   - Frequency (impressions / unique_reach) > 3 — pull `mcp__linkedinAds__get_audience_reach` if needed
   - Spend pacing > 30% above 30d daily average

**Output destination:** if Brad asked for a file, save to `/workspace/extra/clients/projects/<client-slug>/output/linkedin-performance-YYYY-MM-DD.md`. Otherwise inline reply.

---

## Sub-command: `/linkedin-ads-creative-audit <client>`

Flag fatigued creatives and propose refresh candidates.

**Steps:**

1. Resolve `<client>` → `account_id`(s).
2. `mcp__linkedinAds__list_campaigns` for active campaigns.
3. `mcp__linkedinAds__get_creative_performance` for each active campaign, date range last 30 days. Fields: `impressions`, `clicks`, `landing_page_clicks`, `ctr`, `frequency` (or compute), `cost_in_usd`, `started_at`.
4. Score each creative on fatigue signals:
   - **Frequency > 3** (high — primary signal on LinkedIn)
   - **CTR decline:** compare last 7d CTR vs prior 23d CTR; flag if down ≥ 25%
   - **LP click rate decline:** same window logic on `landing_page_clicks / impressions`
   - **Age > 60 days** with declining metrics → strong refresh candidate
   - **Spend concentration:** creative consuming > 40% of campaign spend with below-median LP CTR
5. Output a ranked refresh table:

   | Creative | Campaign | Spend (30d) | Freq | CTR Δ | LP CTR Δ | Age | Verdict | Reason |
   |---|---|---|---|---|---|---|---|---|

   Verdict ∈ { `REFRESH NOW`, `WATCH`, `OK` }. Always include the human-readable reason.

6. End with a 2–4 line plain-English summary: "X creatives at REFRESH NOW; concentrate refresh in <campaign>; expect ~Y% lift from past refreshes."

---

## Sub-command: `/linkedin-ads-launch <client>`

Guided launch flow. **Never** call create endpoints without confirmation. Use `mcp__nanoclaw__ask_user_question` at every decision gate.

**Steps:**

1. Resolve `<client>` → `account_id`. If multiple accounts (BCG RISE), ask which.
2. **Campaign Group:**
   - `mcp__linkedinAds__get_campaign_groups` — list existing groups. Ask via `ask_user_question`: "Use existing group `<name>` (id `<id>`) or create new?"
   - If create new: ask name, status (`ACTIVE`/`DRAFT`), total budget, start/end dates. Show the planned `create_campaign_group` payload back to the user and ask "Confirm create?" before calling `mcp__linkedinAds__create_campaign_group`.
3. **Campaign:**
   - Ask: name, objective (one of LinkedIn objectives — `BRAND_AWARENESS`, `WEBSITE_VISIT`, `ENGAGEMENT`, `VIDEO_VIEW`, `LEAD_GENERATION`, `WEBSITE_CONVERSION`, `JOB_APPLICANT`), daily budget, total budget, bid type, start/end dates, audience.
   - Audience: offer `mcp__linkedinAds__list_saved_audiences` to pick a saved audience, or `mcp__linkedinAds__get_audience_demographics` for new targeting research.
   - Echo the planned `create_campaign` payload. Confirm. Call `mcp__linkedinAds__create_campaign`.
4. **Creative:**
   - Ask for asset (image URL or path). If image: `mcp__linkedinAds__upload_image` first, capture the returned asset URN.
   - Ask: headline, intro text, destination URL (or lead form via `mcp__linkedinAds__list_lead_forms`), call-to-action.
   - Echo the planned `create_creative` payload. Confirm. Call `mcp__linkedinAds__create_creative`.
   - Default status is `DRAFT`. Ask explicitly before flipping to `ACTIVE` via `mcp__linkedinAds__update_creative_status`.
5. Summary back to Brad: campaign group id, campaign id, creative id(s), current statuses, links to LinkedIn Campaign Manager (`https://www.linkedin.com/campaignmanager/accounts/<account_id>/campaigns/<campaign_id>`).

**Safety:** if any create call returns a non-2xx or the SDK throws, stop the flow and report the error verbatim. Do not retry blindly — LinkedIn errors on create are usually structural (missing field, invalid URN format) and need a human fix.

---

## Sub-command: `/linkedin-ads-compare <client1> <client2>`

Cross-account benchmarking. Only meaningful when both clients are in the same vertical (e.g. Cache vs Meadow — both fintech) or have comparable objectives.

**Steps:**

1. Resolve both clients to `account_id`s. If a client has multiple LinkedIn accounts, ask which to use.
2. For each: `mcp__linkedinAds__get_campaign_performance` for last 30 days, aggregated to account level (sum spend/impressions/clicks/LP-clicks/conversions).
3. Optionally: `mcp__linkedinAds__compare_performance` if the date ranges align and the tool accepts multi-account input (otherwise fall back to two single-account calls and reconcile client-side).
4. Build a side-by-side table:

   | Metric | `<client1>` | `<client2>` | Δ | Notes |
   |---|---|---|---|---|
   | Spend (30d) | … | … | … | |
   | Impressions | … | … | … | |
   | LP Clicks | … | … | … | the real traffic metric |
   | LP CTR | … | … | … | impressions → LP clicks |
   | CPC (LP) | … | … | … | spend / LP clicks |
   | CPM | … | … | … | |
   | Leads | … | … | … | if both have leadgen |
   | CPL | … | … | … | spend / leads |
   | Avg Freq | … | … | … | flag if > 3 |

5. Narrative: 3–5 bullets — where `<client1>` outperforms, where `<client2>` outperforms, the one tactical takeaway Brad could lift from the winner. Be explicit when the comparison isn't apples-to-apples (different objective mix, different audience size, different currency — note FX assumptions).
6. **Vertical check:** if the two clients aren't in similar verticals, lead with a warning: "Cross-vertical compare — directional only, not apples-to-apples."

---

## Output conventions (all sub-commands)

- Currency: report in account's billing currency. If comparing across currencies (rare on LinkedIn), state the FX rate and the date you used.
- Dates: ISO `YYYY-MM-DD`, always in account timezone (UTC if LinkedIn doesn't expose one).
- Round spend to 2 decimals, CPC/CPM to 2 decimals, CTR to 2 decimals (percent), frequency to 1 decimal.
- File output path: `/workspace/extra/clients/projects/<client-slug>/output/linkedin-<command>-YYYY-MM-DD.md`. Create the directory if missing.

## Where to escalate

If Brad isn't in chat (scheduled-task context), surface urgent findings via `mcp__nanoclaw__send_message` to the `dm-with-brad` destination. Otherwise inline reply.
