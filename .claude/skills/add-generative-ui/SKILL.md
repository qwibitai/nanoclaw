---
name: add-generative-ui
description: Add a live json-render canvas to NanoClaw with SpecStream JSONL updates over mcp__nanoclaw__update_canvas.
---

# Add Generative UI

This skill installs a live canvas at `http://127.0.0.1:4318/canvas`, exposes `/api/canvas/*`, and wires `mcp__nanoclaw__update_canvas` to send SpecStream JSONL to the canvas web server.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `generative-ui` is already in `applied_skills`, skip to Phase 3.

### Ask the user

1. Keep default `GENUI_PORT=4318` or override?
2. Keep default auth model (main can target registered groups, non-main restricted to own group)?

## Phase 2: Apply

### Initialize skills system (if needed)

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-generative-ui
```

The skill:
- Adds canvas runtime files (`src/canvas-store.ts`, `src/canvas-server.ts`, tests)
- Adds canvas web UI source + tracked dist assets
- Adds `scripts/build-canvas-ui.mjs`
- Adds runtime builder skill `container/skills/generative-ui-builder/SKILL.md`
- Adds helper skills:
  - `container/skills/json-render-core/SKILL.md`
  - `container/skills/json-render-react/SKILL.md`
  - `container/skills/json-render-shadcn/SKILL.md`
- Modifies host/container IPC wiring so `update_canvas` transports JSONL via `POST /api/canvas/:group/events`
- Adds deps/env (`@json-render/*`, `GENUI_PORT`)
- Runs post-apply build (`node scripts/build-canvas-ui.mjs`)

If merge conflicts occur, use `modify/**/*.intent.md`.

### Validate

```bash
npx vitest run --config vitest.skills.config.ts .claude/skills/add-generative-ui/tests/add-generative-ui.test.ts
npx vitest run src/canvas-store.test.ts src/ipc-auth.test.ts
NANOCLAW_SOCKET_TESTS=1 npx vitest run src/canvas-server.test.ts
```

## Phase 3: Verify

### Build and restart

```bash
node scripts/build-canvas-ui.mjs
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### Check runtime

- Open `http://127.0.0.1:4318/canvas`
- Verify APIs:
  - `GET /api/canvas/groups`
  - `GET /api/canvas/<group-folder>/state`
  - `POST /api/canvas/<group-folder>/events` (SpecStream JSONL)

### Verify MCP tool

`mcp__nanoclaw__update_canvas` should be called with `events_jsonl` (JSONL patch ops).

Example payload lines:

```jsonl
{"op":"replace","path":"/root","value":"page"}
{"op":"add","path":"/elements/page","value":{"component":"Container","children":["hero"]}}
{"op":"add","path":"/elements/hero","value":{"component":"Heading","props":{"text":"Hello"}}}
```

## Troubleshooting

### Canvas page says UI missing

Run:

```bash
node scripts/build-canvas-ui.mjs
```

### update_canvas times out

Check:
- `/workspace/ipc/responses` exists in the container mount
- host logs show `update_canvas` tasks being processed
- NanoClaw service is running

### Cross-group update rejected

Expected for non-main groups. Use main context for cross-group canvas updates.
