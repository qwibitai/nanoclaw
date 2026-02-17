# Heartbeat Configuration

## Flux (Coordinator) — Self-Maintenance Schedule

All routines defined in skill: `self-maintenance`

| Time (UTC) | Frequency | Routine | Description |
|-----------|-----------|---------|-------------|
| 00:00 | Daily | Daily Update | Review working.md, governance pipeline, service health, log rotation |
| 01:00 | Daily | GitHub Sync | Commit tracked changes, push to remote, check PRs/issues |
| 02:00 | Daily | Config Review | Audit registered groups, scheduled tasks, ext grants, mounts |
| 02:30 | Daily | Provider Health | Monitor ext_call failures, auto-fix expired/stuck/unused capabilities |
| Every 3 days | 3-day | Sacred Files Audit | Review CLAUDE.md, team.md, tools.md, qa-rules.md for all agents |
| Sunday 03:00 | Weekly | Security Review | Credential scan, vault check, permissions, stale sessions |
| Monday 09:00 | Weekly | Weekly Report | Compile and send status report to main channel |
| 1st & 15th | Bi-weekly | Memory Consolidation | Curate daily notes → topic files for all agents |

## Developer Heartbeats

| Time (UTC) | Frequency | Routine | Description |
|-----------|-----------|---------|-------------|
| */15 min | Continuous | Pipeline Check | Check governance pipeline for new DOING tasks |

## Security Heartbeats

| Time (UTC) | Frequency | Routine | Description |
|-----------|-----------|---------|-------------|
| */15 min | Continuous | Pipeline Check | Check governance pipeline for APPROVAL tasks pending review |
