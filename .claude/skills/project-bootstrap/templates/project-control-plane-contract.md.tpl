# {{PROJECT_DISPLAY_NAME}} Control Plane Contract

## Purpose

Define how this repository is managed through NanoClaw.

## Doc Type

`contract`

## Canonical Owner

This contract owns the local project management split for `{{PROJECT_DISPLAY_NAME}}`.
It does not own the NanoClaw-wide orchestration framework itself.

## Use When

- onboarding or verifying this repo under NanoClaw management
- deciding where work, context, orchestration, and delivery state belong
- checking how Andy/Jarvis lanes should interact with this repo

## Do Not Use When

- changing NanoClaw-wide Symphony architecture
- changing NanoClaw-wide Linear/Notion governance contracts

## Verification

- `npx tsx scripts/workflow/project-bootstrap.ts status --project-key "{{PROJECT_KEY}}"`
- `npx tsx scripts/workflow/symphony.ts show-projects`

## Related Docs

- `CLAUDE.md`
- `AGENTS.md`
- `.nanoclaw/project-bootstrap.json`

## Requirements

1. `Linear` is the execution system of record: {{LINEAR_PROJECT_URL}}
2. `Notion` is the shared context system of record: {{NOTION_ROOT_URL}}
3. `Session Context` lives at: {{SESSION_CONTEXT_URL}}
4. `GitHub` is the delivery surface for `{{GITHUB_REPO}}`
5. `Symphony` is enabled under mode `{{PROJECT_MODE}}`

## Validation Gates

1. new committed work must exist in Linear
2. shared context changes must exist in Notion
3. Symphony may operate only on approved `Ready` work
4. local repo files must not become a second task tracker

## Exit Criteria

This contract is healthy when:

1. `{{PROJECT_KEY}}` appears in the Symphony project registry
2. the repo can be managed without manual cross-tool rewiring
3. Andy/Jarvis lanes can discover the same Linear/Notion/Symphony/GitHub surfaces from this repo
