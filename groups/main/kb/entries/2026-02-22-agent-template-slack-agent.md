---
type: tip
title: "Agent Template — Slack Agent"
tags: [template, slack, agent, triage]
related: []
created: 2026-02-22
source: knowledge-warehouse
score: 0
last_reviewed: null
---

Purpose: Handle Slack triage, summaries, and light automation in specific channels.

Inputs: Slack events, slash commands, scheduled jobs.
Outputs: Threaded replies, summaries, action items, follow-up tasks.
Required config: Bot token, signing secret, channel allowlist, rate limits.
Safety: Ignore DMs by default, redact secrets, require explicit user confirmation for actions.
Validation: Replay sample event payloads and confirm correct responses in a test channel.
