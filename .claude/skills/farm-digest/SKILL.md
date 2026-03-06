---
name: farm-digest
description: Generate hourly or daily Farm operations digests across repos. Use for snapshots of approved tasks, coding progress, and review-ready items.
---

# Farm Digest

Create a concise operational digest for Farm-managed work.

## Use when

1. User asks for hourly/daily updates.
2. User wants a snapshot of what to launch, review, or merge.

## Required environment

```bash
export FARM_CONFIG="/workspace/extra/farm/config.cloud.yaml"
export FARM_REPOS="farm scout train"
```

## Workflow

1. For each repo in `$FARM_REPOS`, run:

```bash
farm pulse --config "$FARM_CONFIG" --repo "<repo>"
```

2. For any issue currently in Coding, run:

```bash
farm status --config "$FARM_CONFIG" --repo "<repo>" --issue "<issue-id>"
```

3. Use read-only Linear discovery to find:
1. Approved child tasks (ready to launch)
2. Done/In Review items with PR links (ready to review)

Reference: `references/linear_read_query.md`.

4. Format the user message with `references/digest_template.md`.

## Rules

1. Keep digest compact and operational.
2. Include explicit issue ids.
3. Treat read failures as warnings, not hard failures.
