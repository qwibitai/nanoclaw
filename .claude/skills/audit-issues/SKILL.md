---
name: audit-issues
description: Periodic issue taxonomy audit — checks label coverage, epic health, incident density, horizon coverage, and unlabeled issues. Produces structured report with suggested fixes. Triggers on "audit issues", "issue health", "label audit", "taxonomy check", "issue hygiene".
---

# /audit-issues — Periodic Issue Taxonomy Audit

**Role:** The auditor. Systematically checks the health of the kaizen issue backlog — label coverage, epic lifecycle, incident density, and horizon distribution. Produces a structured report with suggested fixes.

**Philosophy:** See the [Zen of Kaizen](../../kaizen/zen.md) — *"No promises without mechanisms"* and *"A good taxonomy of the problem outlasts any solution."*

**When to use:**
- Periodic review (every 2-4 weeks or every 10 PRs)
- When `/gap-analysis` or `/pick-work` surface data quality issues
- When `kaizen-bg` health summary shows `attention-needed` or `critical`
- When the user asks about issue hygiene, label coverage, or backlog health

## The Audit

### Step 1: Gather all open issues

```bash
# All open issues with full metadata
gh issue list --repo Garsson-io/kaizen --state open --limit 200 \
  --json number,title,labels,body,createdAt,updatedAt,comments
```

### Step 2: Label coverage audit

Every kaizen issue MUST have: `kaizen` + level (`level-1`/`level-2`/`level-3`) + area (`area/*`).

```bash
# Find issues missing required labels
gh issue list --repo Garsson-io/kaizen --state open --limit 200 --json number,title,labels \
  --jq '.[] | select(
    (.labels | map(.name) |
      (any(test("^kaizen$")) and any(test("^level-")) and any(test("^area/")))
    | not)
  ) | "\(.number)\t\(.title)\t\(.labels | map(.name) | join(", "))"'
```

For each unlabeled issue, suggest labels based on title and body keywords:
- Title contains "hook" or "enforcement" -> `area/hooks`
- Title contains "skill" or "slash command" -> `area/skills`
- Title contains "case" or "routing" -> `area/cases`
- Title contains "deploy" or "build" -> `area/deploy`
- Title contains "test" or "coverage" -> `area/testing`
- Title contains "container" or "docker" -> `area/container`
- Title contains "worktree" or "branch" -> `area/worktree`
- Title starts with `[L1]` -> `level-1`, `[L2]` -> `level-2`, `[L3]` -> `level-3`

### Step 3: Epic health audit

Epics are directions that stay open. But they need active maintenance.

```bash
# Open epics
gh issue list --repo Garsson-io/kaizen --state open --label "epic" --limit 50 \
  --json number,title,updatedAt,body,comments

# Closed epics (should be rare — epics are directions, not deliverables)
gh issue list --repo Garsson-io/kaizen --state closed --label "epic" --limit 50 \
  --json number,title,closedAt
```

Check each epic for:
- **Stale body:** No update in 4+ weeks — the direction may have drifted
- **No sub-issues linked:** Epic exists but nothing is tracked under it
- **Prematurely closed:** Epics are infinite games; closing one requires explicit "direction abandoned" rationale

### Step 4: Incident density audit

Incidents are the most valuable data in the kaizen system. Issues without incidents are hypotheses; issues with incidents are evidence.

```bash
# Count incidents per issue (look for "## Incident" in comments)
gh issue list --repo Garsson-io/kaizen --state open --limit 200 --json number,title,comments \
  --jq '.[] | {
    number,
    title,
    incident_count: ([.comments[].body | select(test("## Incident"))] | length)
  } | select(.incident_count == 0) | "\(.number)\t\(.title)"'
```

Report:
- Total open issues
- Issues with 0 incidents (hypotheses)
- Issues with 1+ incidents (evidence-backed)
- Issues with 3+ incidents (high-priority evidence)
- Incident-to-issue ratio

### Step 5: Horizon coverage audit

```bash
# Issues per horizon
gh issue list --repo Garsson-io/kaizen --state open --limit 200 --json number,labels \
  --jq '[.[].labels[].name | select(startswith("horizon/"))] | group_by(.) | map({horizon: .[0], count: length}) | sort_by(-.count)'

# Issues with NO horizon label
gh issue list --repo Garsson-io/kaizen --state open --limit 200 --json number,title,labels \
  --jq '.[] | select(.labels | map(.name) | any(startswith("horizon/")) | not) | "\(.number)\t\(.title)"'
```

Check:
- Are any horizons empty (zero issues)?
- Are issues concentrated in 1-2 horizons while others starve?
- Are there issues that should have a horizon label but don't?

### Step 6: Staleness audit

```bash
# Issues not updated in 30+ days
gh issue list --repo Garsson-io/kaizen --state open --limit 200 --json number,title,updatedAt \
  --jq '[.[] | select(.updatedAt < (now - 2592000 | strftime("%Y-%m-%dT%H:%M:%SZ")))] | sort_by(.updatedAt) | .[:10][] | "\(.number)\t\(.title)\t\(.updatedAt)"'
```

### Step 7: Produce the report

Output a structured report:

```
AUDIT REPORT (YYYY-MM-DD)
=========================

## Summary
- Total open issues: N
- Label coverage: N/N (X%)
- Incident density: N issues with incidents / N total (X%)
- Epic health: N open epics, N stale, N prematurely closed
- Horizon coverage: N horizons active, N empty

## Label Coverage Issues (N issues)
| # | Title | Has | Missing | Suggested |
|---|-------|-----|---------|-----------|
| ... | ... | kaizen | level-2, area/hooks | level-2, area/hooks |

## Epic Health
| # | Title | Status | Issue |
|---|-------|--------|-------|
| ... | ... | stale (last update: date) | needs body refresh |

## Incident Density
- Issues with 0 incidents: N (list top 10)
- Issues with 1+ incidents: N
- Issues with 3+ incidents: N (high-priority)
- Ratio: X incidents per issue

## Horizon Distribution
| Horizon | Open Issues | Assessment |
|---------|-------------|------------|
| horizon/testability | N | balanced |
| horizon/autonomous-kaizen | N | over-concentrated |
| (no horizon) | N | needs triage |

## Stale Issues (no update in 30+ days)
| # | Title | Last Updated |
|---|-------|-------------|
| ... | ... | ... |

## Recommended Actions
1. [highest-impact fix] — apply labels to N unlabeled issues
2. [second-highest] — record incidents for top-priority issues
3. ...
```

### Step 8: Offer to fix

After presenting the report, offer:
1. **Apply suggested labels** — for each unlabeled issue, run `gh issue edit --add-label`
2. **Reopen prematurely closed epics** — with a comment explaining why
3. **File meta-incidents** — record the audit findings as incidents on #235 (taxonomy epic) and #237 (audit skill epic)

Ask the user which fixes to apply. Apply only what's confirmed.

## Integration Points

| Consumer | How it uses audit data |
|----------|-----------------------|
| `kaizen-bg` (step 6) | Health summary in every reflection — surfaces problems continuously |
| `/gap-analysis` | Label distribution feeds concentration analysis |
| `/pick-work` | Warns about unlabeled issues excluded from scoring |
| `/kaizen` | Triggers advisory after N cases without audit |

## Anti-patterns

- **Fixing labels without reading the issue** — Don't blindly apply keyword-based suggestions. Read the issue body to confirm the labels are correct.
- **Counting without reasoning** — "5 unlabeled issues" is less useful than "5 unlabeled issues, 3 of which are hook-related and should be `area/hooks, level-2`"
- **Running the audit but not acting** — The report is not the goal. The goal is the fixes. If the user doesn't confirm actions, at minimum file the findings as an incident on #237.
