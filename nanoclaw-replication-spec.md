# Specification: NanoClaw Setup — Popashot Replication from OpenClaw

**Generated from:** Interview of clawdbot-backup at ~/d/git/clawdbot-backup
**Interview date:** 2026-04-08
**Version:** 1.0

## Executive Summary

Replicate the Popashot agent from the OpenClaw/clawdbot fleet into NanoClaw running on Discord. Single agent (popashot) with full personality, standing orders, cron jobs, bug workflows, and integrations (Slack, Sentry, GitHub). Port existing learnings (286 patterns, 2202 corrections).

## Objectives

### Primary Goals
- Popashot persona fully operational on Discord with identical personality, voice, and behavior
- Bug report pipeline: separate #bug-reports channel → auto GitHub issues (SHOTClubhouse)
- All 18 standing orders adapted for single-agent NanoClaw
- Four cron jobs: daily pipeline update, reflection cycle, pipeline poll, system backup
- Slack, Sentry, and GitHub integrations active

### Success Metrics
- Popashot responds in Discord with correct personality (no praise, direct, dry wit)
- Bug reports in #bug-reports auto-create GitHub issues with images via imgbb
- Daily 7:30 AM pipeline summary posted to Discord
- Sentry alerts route to Discord channel

## Scope

### In Scope
- Popashot persona (SOUL.md, IDENTITY.md) → groups/discord_nano/CLAUDE.md
- Standing orders (18 rules) adapted for single-agent
- Discord channels: nano (main), bug-reports (silent auto-issue), alpha-testing (active)
- Cron: daily update, reflection cycle, pipeline poll, system backup
- Integrations: Slack (existing token), Sentry (existing config), GitHub CLI
- Port 286 patterns + key corrections into container skills / CLAUDE.md
- Repo config: SHOTClubhouse/SHOTclubhouse, mission-control, wololo-platform, biolift

### Out of Scope
- Other agents (cantona, splinter, zerocool, tank, velma, slash) — add later
- WhatsApp channel — Discord only for now
- Mission Control / Convex inbox system — adapt for NanoClaw's architecture
- Browser profile / cookies from old setup
- 60 old skills — install as needed via NanoClaw skill system

### Future Considerations
- Expand to full fleet (7 agents) as separate NanoClaw groups
- WhatsApp channel via /add-whatsapp
- Mission Control integration

## Technical Requirements

### Persona Configuration

**File:** `groups/discord_nano/CLAUDE.md`

Port from backup:
- SOUL.md personality: dry wit, no praise, professional + light, Andy Grove DNA
- IDENTITY.md: signature moves, anti-patterns, voice
- Emoji language table
- Agent-to-agent comms rules (adapted for single agent)
- Correction logging protocol
- Repo routing config (app→SHOTclubhouse, platform→wololo, dashboard→mission-control, biolift→biolift)

### Discord Channels

| Channel | Type | NanoClaw JID | Behavior |
|---------|------|-------------|----------|
| nano | Main | dc:1491178527498960966 | Responds to all messages, no trigger needed |
| bug-reports | Silent | dc:TBD | Auto-create GitHub issue, NEVER reply in channel |
| alpha-testing | Trigger | dc:TBD | Responds when @popashot mentioned |

User needs to create #bug-reports and #alpha-testing channels in Discord, then provide channel IDs.

### Standing Orders (Adapted for Single Agent)

Rules to **port as-is** (adapted wording):
1. ~~Inbox Protocol~~ → Simplified: track tasks, no MC API needed
2. ~~Tagging~~ → N/A (single agent)
3. **Repetition Detection** → Keep: no restating, detect loops
4. **Git Discipline** → Keep: never commit to main, branch + PR, worktrees
5. **Discord Formatting** → Keep: tables as code blocks, box-drawing chars
6. **Coding Tools** → Keep: Claude Code primary, agents are foremen
7. **Safety** → Keep: no gateway restarts from own session, no secrets in chat
8. **Correction Logging** → Keep: immediate logging, HOT tier promotion
9. **Config Safety** → Adapt for NanoClaw config structure
10. **Reply Style** → Keep: no "Great question!", direct, no filler
11. ~~Mortal Inbox~~ → Simplified: ask Stevie directly when blocked
12. **Discord Threads** → Keep: thread-per-task, status in main, detail in threads
13. **Security PR Gate** → Keep: security PRs need extra review before merge
14. **Coding Session Lifecycle** → Keep: own your cleanup (tmux, worktrees)
15. **Discovery Gossip** → Keep: publish non-obvious findings
16. **Research Loop** → Keep: PROPOSAL.md for architectural changes
17. **Repo Manifest Protocol** → Keep: read .clan/manifest.yaml first
18. ~~Agent Comms Protocol~~ → Simplified for single agent

### Integrations

| Integration | Source | Config |
|-------------|--------|--------|
| Slack | Backup token | `<SLACK_BOT_TOKEN>` (see `.env`, not committed) |
| Sentry | Backup config | org: shotclubhouse, project: shotapp, url: https://de.sentry.io/ |
| GitHub | Already configured | gh CLI with existing auth |

### Cron Jobs

| Job | Schedule | Description |
|-----|----------|-------------|
| Daily pipeline update | `30 7 * * *` | Git/PR/issue activity summary → Discord |
| Reflection cycle | `0 9,21 * * *` | Scan for corrections, propose improvements |
| Pipeline poll | `*/15 * * * *` | Poll CI/CD status, PR updates |
| System backup | `0 */6 * * *` | Backup configs/state (NEW REPO needed) |

### Learnings to Port

| Source | Count | Destination |
|--------|-------|-------------|
| patterns.md | 286 patterns | Container skill or CLAUDE.md appendix |
| corrections-raw.jsonl | 2,202 entries | Summarized into key patterns in CLAUDE.md |
| discoveries.jsonl | 36 entries | Container skill reference |

### Bug Report Pipeline (Discord)

1. Message in #bug-reports channel detected
2. Check for image attachments
3. Upload images to imgbb (API key: `<IMGBB_API_KEY>`, loaded from `.env`)
4. Create GitHub issue in SHOTClubhouse/SHOTclubhouse with image embeds
5. Add to project board (#6)
6. Post notification in #alpha-testing with issue link
7. NEVER reply in #bug-reports itself

### Environment Variables

```env
ASSISTANT_NAME=popashot
TZ=Europe/London
DISCORD_BOT_TOKEN=<YOUR_DISCORD_BOT_TOKEN>
SLACK_BOT_TOKEN=<YOUR_SLACK_BOT_TOKEN>
SENTRY_AUTH_TOKEN=<YOUR_SENTRY_AUTH_TOKEN>
SENTRY_ORG=shotclubhouse
SENTRY_PROJECT=shotapp
SENTRY_URL=https://de.sentry.io/
ONECLI_URL=http://127.0.0.1:10254
IMGBB_API_KEY=<YOUR_IMGBB_API_KEY>
```

## Constraints & Dependencies

### Technical Constraints
- NanoClaw runs one agent per group (no fleet orchestration built-in)
- Container isolation means agent can't directly access host filesystem except via mounts
- Standing orders must be in CLAUDE.md (loaded into container at runtime)

### External Dependencies
- Discord bot must have Message Content Intent enabled
- GitHub CLI must be authenticated in container
- Sentry API access from container
- imgbb API for image hosting

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| CLAUDE.md too large (persona + rules + patterns) | Med | Med | Split into CLAUDE.md (core) + container skills (patterns, workflows) |
| Bug report pipeline can't access Discord attachments | High | Low | Discord.js provides attachment URLs; download in container |
| Cron jobs not yet native to NanoClaw | Med | Med | Use NanoClaw task-scheduler or system cron |
| Backup repo not yet created | Low | High | Create new repo before configuring backup cron |

## Implementation Priority

1. **Persona** — Write CLAUDE.md with popashot personality + standing orders
2. **Integrations** — Add Slack token, Sentry config, GitHub to .env + OneCLI
3. **Bug channels** — Register #bug-reports and #alpha-testing Discord channels
4. **Cron jobs** — Configure scheduled tasks
5. **Learnings** — Port patterns into container skills
6. **Backup** — Create new backup repo, configure backup cron

## Open Questions

- [ ] What Discord channel IDs for #bug-reports and #alpha-testing? (User needs to create them)
- [ ] What repo for system backup? (User said "will need a new repository")
- [ ] Should Slack also be a NanoClaw channel (via /add-slack) or just an outbound notification target?

---

*This specification was generated through systematic interview of the plan author.*
