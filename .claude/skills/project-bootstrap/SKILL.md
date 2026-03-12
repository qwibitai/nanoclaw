---
name: project-bootstrap
description: Onboard an existing GitHub project into the NanoClaw operating model. Use when the user wants a repo managed like NanoClaw with Linear for tasks, Notion for shared context, Symphony for orchestration, GitHub for delivery, and Andy/Jarvis lane defaults wired consistently.
---

# Project Bootstrap

Use this skill when a repo should be managed through the `Linear + Notion + Symphony + GitHub` model instead of ad hoc project setup.

## Workflow

1. Resolve the target repo identity and local checkout path.
2. Choose the project mode:
   - `nanoclaw-like`
   - `downstream-product`
3. Inspect existing control-plane state first.
4. Run a dry-run bootstrap and confirm the plan is complete.
5. Apply the bootstrap only when the dry-run is clean.
6. Validate Symphony registry sync and runtime visibility after wiring.

## Commands

Inspect:

```bash
npx tsx scripts/workflow/project-bootstrap.ts inspect --repo "<owner/repo|github-url|local-path>" --mode <nanoclaw-like|downstream-product> [--local-path "<path>"]
```

Dry-run:

```bash
npx tsx scripts/workflow/project-bootstrap.ts dry-run --repo "<owner/repo|github-url|local-path>" --mode <nanoclaw-like|downstream-product> [--local-path "<path>"]
```

Apply:

```bash
npx tsx scripts/workflow/project-bootstrap.ts apply --repo "<owner/repo|github-url|local-path>" --mode <nanoclaw-like|downstream-product> --local-path "<path>"
```

Status:

```bash
npx tsx scripts/workflow/project-bootstrap.ts status --project-key "<project-key>"
```

## Required Inputs

- existing GitHub repo
- local checkout path for `apply`
- `NOTION_PROJECT_REGISTRY_DATABASE_ID`
- `NOTION_KNOWLEDGE_PARENT_PAGE_ID`
- `NOTION_SESSION_CONTEXT_PARENT_PAGE_ID`
- `LINEAR_API_KEY`
- `NANOCLAW_LINEAR_TEAM_KEY`

## Mode Defaults

### `nanoclaw-like`

- allowed backends: `codex`, `claude-code`
- default backend: `claude-code`
- work classes: `nanoclaw-core`, `governance`, `research`

### `downstream-product`

- allowed backends: `opencode-worker`
- default backend: `opencode-worker`
- work classes: `downstream-project`

## Bundled Templates

The bootstrap tool uses the local templates in `templates/` for the target repo pack:

- `CLAUDE.md.tpl`
- `AGENTS.md.tpl`
- `project-control-plane-contract.md.tpl`
- `symphony-mcp.sh.tpl`

Do not handcraft those files in target repos during onboarding; let the bootstrap tool render them.

## Verification

```bash
npx tsx scripts/workflow/project-bootstrap.ts dry-run --repo "<repo>" --mode <mode> --local-path "<path>"
npx tsx scripts/workflow/project-bootstrap.ts apply --repo "<repo>" --mode <mode> --local-path "<path>"
npm run symphony:sync-registry
npm run symphony:status
npx tsx scripts/workflow/symphony.ts show-projects
```

## Fail-Loud Rules

- Do not create a fallback local work tracker.
- Do not proceed without a verifiable GitHub repo identity.
- Do not proceed without the required Notion parent pages and Linear team key.
- Do not overwrite existing target-repo instruction files silently; only create missing ones or update generated NanoClaw-managed files.
