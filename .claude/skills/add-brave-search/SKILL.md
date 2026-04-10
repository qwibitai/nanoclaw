---
name: add-brave-search
description: Add or maintain Brave Search support in this NanoClaw fork by wiring the BRAVE-TOKEN environment variable, checking the current search path, and implementing Brave API-backed search when the user wants web search routed through Brave.
---

# Add Brave Search

Use this skill when the user wants Brave Search integrated into this NanoClaw fork.

## What This Skill Enables

- Wires Brave Search credentials from `.env`
- Audits whether the current runtime already has a search backend
- Implements or updates Brave Search API usage in the relevant code path
- Verifies the configured token key is `BRAVE-TOKEN`

## Required Environment

The local `.env` should contain:

```env
BRAVE-TOKEN=your_brave_api_token
```

## Workflow

1. Inspect the current codebase for any existing search integration before changing code.
2. If Brave support is missing, add it in the smallest clean way that fits the current architecture.
3. Prefer keeping credential handling centralized in existing env helpers.
4. If the user also wants the dashboard updated, expose the Brave capability there too.
5. Run typecheck/tests after changes.

## Constraints

- Do not hardcode secrets in source files.
- Do not claim Brave is active unless the token is configured and the code path exists.
- If a network-backed smoke test is not possible, say so clearly.
