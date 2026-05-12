# Daily Digest

v2 supports daily digests two ways: a built-in host-side default (covers
ship_log + backlog automatically for every wired group) and an agent-driven
pattern (richer per-group content via `schedule_task`). They coexist —
pick the one that fits the use case, or run both.

## Path A — Host-side daily summary (default)

Shipped at `src/daily-summary.ts`. Runs a 5-min tick on the host; fires
once a day per agent group at the configured hour-in-TZ, posts a digest
to the group's wired channel. Skips groups with no recent activity. No
per-group setup required — runs out of the box for every agent group
already wired to a channel.

**What it includes:**

- **🤖 Agent Shipped** — `ship_log` entries (last 24h), grouped by repo.
  Populated by `commit-scan` (host-side, default-branch commits in cloned
  repos) and the `add_ship_log` MCP tool agents call inline.
- **✅ Resolved** — backlog items with `status IN ('resolved','wont_fix')`
  and `resolved_at >= since`.
- **📌 Open Backlog** — all `open` + `in_progress` backlog items, with
  priority emoji + an `[in progress]` suffix.

**Sections are omitted when empty.** A group whose all-three are empty
gets no message that day.

**What it does NOT include** (vs v1):

- GitHub team-PR section (`fetchGithubMergedPRs`) — skipped at port
  time. `commit-scan` already covers default-branch shipping in locally
  cloned repos; the gap is non-cloned team repos + author attribution.
  Add by porting v1's `fetchGithubMergedPRs` if/when it matters.

**Config — env vars (set on the host service):**

| Var | Default | Purpose |
|---|---|---|
| `DAILY_SUMMARY_ENABLED` | `1` | Set to `0` to disable host-side digest entirely. |
| `DAILY_SUMMARY_HOUR` | `8` | Local hour (0–23) in `DAILY_SUMMARY_TZ`. |
| `DAILY_SUMMARY_TZ` | `America/New_York` | IANA TZ string. |

**Config — per-group override:** by default the digest goes to the
agent group's primary wired channel (highest `mga.priority`, oldest
tiebreak). To target a different wired channel, set
`dailySummary.messagingGroupId` in the group's `container.json`:

```json
"dailySummary": {
  "messagingGroupId": "mg-1776735605486-p87hha2"
}
```

Look up the id via:

```sql
SELECT id, channel_type, platform_id, name FROM messaging_groups
WHERE name LIKE '%channel-name%';
```

Example: illysium's `container.json` routes the digest to Slack
`#agents-xzo` even though Discord is the primary wiring.

**State:** `data/daily-summary-state.json` tracks the
`lastFiredDateKey` (YYYY-MM-DD in TZ) so a host restart on the same day
doesn't re-fire.

**Lifecycle:** `startDailySummary()` boots from `src/index.ts` after
commit-scan; `stopDailySummary()` runs in `shutdown()` alongside other
host-side timers.

## Path B — Agent-driven digest (richer content)

The host-side default covers `ship_log` + `backlog`. If you want the
digest to pull from other sources — auto-memories, recent threads, `git
log`, `gh pr list`, MCP tools — schedule it through the agent instead.

In the chat where you want the digest delivered, say something like:

> Schedule a recurring task to run at 8am America/New_York every day.
> When it runs, search my recent threads and memories for what I
> shipped yesterday, any PRs I opened or merged, scheduled tasks that
> completed, and anything notable in the archive. Reply with a 5–8
> line summary. Skip the message entirely on days with nothing
> noteworthy — don't send "nothing happened" filler.

The agent calls `schedule_task` with `processAfter` = next 8am in TZ,
`recurrence = '0 8 * * *'`, and the prompt. When the task fires, the
agent re-runs, pulls from whatever tools it has access to, composes
the summary, and replies in the same chat.

**Variations:**

- **Per-project:** schedule inside the project's thread; the agent
  scopes itself by context.
- **Weekly:** swap cron to `0 8 * * 1`.
- **Different content:** re-run `schedule_task` (or `update_task`) with
  a new prompt — no code change.
- **Team digests:** the agent runs the summary prompt and cross-posts
  via the agent-to-agent messaging primitive (when wired).

**Cost:** each agent run costs tokens; host-side path costs nothing per
fire. If the content stays simple (ship_log + backlog), prefer Path A.
Use Path B when you need narrative summarization or sources the host
doesn't read.

## When to pick which

| Need | Path |
|---|---|
| Default coverage for all groups, zero setup | A |
| Custom prompt per group | B |
| Sources beyond ship_log + backlog (memories, threads, git, gh) | B |
| Strict cost ceiling (no agent tokens per fire) | A |
| Skip-empty without agent judgment | A |
| Narrative phrasing, "what mattered" framing | B |

Running both for the same group is fine — they're independent posts.
