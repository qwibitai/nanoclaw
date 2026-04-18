---
name: qa-patrol
description: Run QA tests against apps via Playwright. Create runs with explicit steps or AI-generated instructions, manage reusable workflows, and retrieve markdown reports.
allowed-tools: Bash(curl:*)
---

# QA Patrol API

QA-as-a-Service. Send structured workflow steps (or free-text instructions) + a target app; QA Patrol executes them via Playwright, captures evidence (screenshots, console logs, network errors), and returns structured reports.

## Base URL

```
http://host.docker.internal:3042/api/v1
```

## Quick Reference

### Run QA on an app by name

```bash
curl -s -X POST http://host.docker.internal:3042/api/v1/runs \
  -H 'Content-Type: application/json' \
  -d '{
    "app": "Flights",
    "steps": [
      { "action": "navigate", "target": "/", "description": "Load home page" },
      { "action": "screenshot", "description": "Capture home page" },
      { "action": "assert-visible", "target": ".deal-card", "description": "Deal cards visible" }
    ],
    "requestedBy": "nanoclaw"
  }' | jq .
```

### Run QA on a direct URL

```bash
curl -s -X POST http://host.docker.internal:3042/api/v1/runs \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "https://flights.jeffreykeyser.net",
    "steps": [
      { "action": "navigate", "target": "/", "description": "Load home" },
      { "action": "screenshot", "description": "Capture home page" }
    ]
  }' | jq .
```

### Run QA with AI-generated steps (instructions)

```bash
curl -s -X POST http://host.docker.internal:3042/api/v1/runs \
  -H 'Content-Type: application/json' \
  -d '{
    "app": "Flights",
    "instructions": "Navigate to the home page, verify deal cards are visible, click the first deal, and confirm the details page loads",
    "requestedBy": "nanoclaw"
  }' | jq .
```

When `instructions` is provided instead of `steps`, QA Patrol uses an LLM to auto-generate the step array from free text.

### Get run details

```bash
curl -s http://host.docker.internal:3042/api/v1/runs/RUN_ID | jq .
```

### Get markdown report

```bash
curl -s http://host.docker.internal:3042/api/v1/runs/RUN_ID/report
```

### Promote a run to a workflow

```bash
curl -s -X POST http://host.docker.internal:3042/api/v1/runs/RUN_ID/promote | jq .
```

Converts a completed ad-hoc run into a reusable workflow.

### List runs

```bash
# All runs (filterable: ?app=Flights&status=pass&limit=10)
curl -s http://host.docker.internal:3042/api/v1/runs | jq .
```

## Workflows

Reusable test sequences. Create once, execute many times.

### Create a workflow

```bash
curl -s -X POST http://host.docker.internal:3042/api/v1/workflows \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Flights smoke test",
    "app": "Flights",
    "steps": [
      { "action": "navigate", "target": "/", "description": "Load home page" },
      { "action": "screenshot", "description": "Capture home page" },
      { "action": "assert-visible", "target": ".deal-card", "description": "Deal cards visible" }
    ]
  }' | jq .
```

### List workflows

```bash
curl -s http://host.docker.internal:3042/api/v1/workflows | jq .
```

### Get workflow

```bash
curl -s http://host.docker.internal:3042/api/v1/workflows/WORKFLOW_ID | jq .
```

### Update workflow

```bash
curl -s -X PUT http://host.docker.internal:3042/api/v1/workflows/WORKFLOW_ID \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Flights full regression",
    "steps": [
      { "action": "navigate", "target": "/", "description": "Load home page" },
      { "action": "screenshot", "description": "Capture home page" },
      { "action": "assert-visible", "target": ".deal-card", "description": "Deal cards visible" },
      { "action": "click", "target": ".deal-card:first-child", "description": "Click first deal" },
      { "action": "screenshot", "description": "Capture deal details" }
    ]
  }' | jq .
```

### Delete workflow

```bash
curl -s -X DELETE http://host.docker.internal:3042/api/v1/workflows/WORKFLOW_ID | jq .
```

### Execute a workflow

```bash
curl -s -X POST http://host.docker.internal:3042/api/v1/workflows/WORKFLOW_ID/run | jq .
```

Creates and executes a new run from the workflow's saved steps.

## Apps (proxied from Pay)

```bash
# List all registered apps
curl -s http://host.docker.internal:3042/api/v1/apps | jq .

# Get single app
curl -s http://host.docker.internal:3042/api/v1/apps/APP_ID | jq .
```

No local app storage — Pay is the single source of truth.

## Step Actions

| Action | Target | Value | Description |
|--------|--------|-------|-------------|
| `navigate` | URL path or full URL | — | Go to page |
| `click` | CSS selector | — | Click element |
| `fill` | CSS selector | text | Fill input field |
| `screenshot` | — | — | Capture screenshot |
| `assert-visible` | CSS selector | — | Fail if element not visible |
| `assert-text` | CSS selector | expected text | Fail if text not found |
| `wait` | — | ms (default 2000) | Wait before next step |

## Options

Pass in the `options` object when creating a run:

```json
{
  "options": {
    "captureConsoleErrors": true,
    "screenshotEachStep": true,
    "timeout": 120000,
    "viewport": { "width": 1920, "height": 1080 }
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `captureConsoleErrors` | `true` | Capture browser console errors in results |
| `screenshotEachStep` | `true` | Auto-screenshot after every step |
| `timeout` | `120000` | Max run duration in ms |
| `viewport` | `1920×1080` | Browser viewport size |

## Run Status Values

`pending` → `running` → `pass` | `partial` | `fail` | `error`

- **pass**: All steps passed
- **partial**: Some passed, some failed
- **fail**: All failed or no passes
- **error**: Execution crashed (browser launch failure, etc.)

## Health Check

```bash
curl -s http://host.docker.internal:3042/health | jq .
```
