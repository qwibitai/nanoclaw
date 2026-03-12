# {{PROJECT_DISPLAY_NAME}}

Managed through the NanoClaw project bootstrap model.

## Control Plane

- `Linear` owns task state: {{LINEAR_PROJECT_URL}}
- `Notion` owns shared context: {{NOTION_ROOT_URL}}
- `Session Context` lives at: {{SESSION_CONTEXT_URL}}
- `GitHub` owns code delivery for `{{GITHUB_REPO}}`
- `Symphony` is the approved orchestration surface for this repo under mode `{{PROJECT_MODE}}`

## Working Contract

1. Start vague work in Notion, not in GitHub.
2. Move committed execution work into Linear only.
3. Use Symphony only for approved `Ready` implementation work.
4. Keep repo files limited to code, tests, and local execution contracts.

## Project Identity

- `Project Key`: `{{PROJECT_KEY}}`
- `Mode`: `{{PROJECT_MODE}}`

See `docs/operations/project-control-plane-contract.md` for the local operating contract.
