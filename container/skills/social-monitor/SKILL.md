---
name: social-monitor
description: Generic social media timeline monitoring framework. Provides fetch-filter-decide-act pipeline for autonomous engagement. Platform-specific skills implement the SocialMonitor interface.
---

# Social Monitor Framework

Generic pipeline for autonomous social media engagement.

## Architecture

```
fetch timeline → filter (dedup) → decide (Claude) → act (with approval) → sync to platform
```

## Usage

Platform skills (X, LinkedIn, etc.) implement the `SocialMonitor` interface from `interfaces.ts` and pass it to `runMonitorCycle()` from `framework.ts`.

## Files

- `interfaces.ts` — Type definitions
- `framework.ts` — Pipeline orchestrator
- `dedup.ts` — Seen items deduplication store
- `engagement-log.ts` — Audit trail
- `decision-prompt.ts` — Claude prompt builder
