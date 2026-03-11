# DayZero API

HTTP API for triggering workflow runs (DayZero assessments, etc.) via NanoClaw.

## Overview

The DayZero channel exposes an HTTP server (default port `9002`) that accepts
requests to run agent workflows. Each request spawns a NanoClaw container agent
that executes the specified workflow type.

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `DAYZERO_PORT` | `9002` | HTTP port for the DayZero API |
| `DAYZERO_API_KEY` | — | API key for authentication (optional but recommended) |

### Prerequisites

- DayZero repo cloned at `/root/geodesic-explore/DayZero`
- Mount allowlist (`~/.config/nanoclaw/mount-allowlist.json`) includes `/root/geodesic-explore` as an allowed root
- Group `internal:dayzero` registered in the NanoClaw database
- Workflow data packages present at the expected path for the workflow type

## Authentication

Set `DAYZERO_API_KEY` in `.env` to enable authentication. When set, all
endpoints except `/health` require one of:

- `X-Api-Key: <key>` header
- `Authorization: Bearer <key>` header

If `DAYZERO_API_KEY` is not set, the API accepts unauthenticated requests.

## Endpoints

### `GET /health`

Returns API status and active runs. No authentication required.

**Response:**
```json
{
  "status": "ok",
  "active_runs": 1,
  "runs": [
    { "id": "a1b2c3d4", "workflow_type": "dayzero" }
  ]
}
```

### `POST /v1/run`

Start a new workflow run.

**Request body:**
```json
{
  "workflow_type": "dayzero",
  "engagement_mode": "turnaround_diagnostic",
  "phase": "phase_2",
  "workflow_run_id": "uuid",
  "tenant_id": "uuid",
  "workspace_id": "uuid"
}
```

| Field | Required | Default | Description |
|---|---|---|---|
| `workflow_type` | Yes | — | Workflow type to run (e.g. `dayzero`, `financial-analysis`) |
| `engagement_mode` | No | `turnaround_diagnostic` | Mode for the workflow |
| `phase` | No | — | Resume from a specific phase instead of starting from the beginning |
| `workflow_run_id` | No | — | Geodesic workflow run ID for progress tracking |
| `tenant_id` | No | — | Geodesic tenant ID |
| `workspace_id` | No | — | Geodesic workspace ID |

**Response:**
```json
{
  "status": "started",
  "run_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "workflow_type": "dayzero",
  "engagement_mode": "turnaround_diagnostic",
  "poll_url": "/v1/runs/a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

### `GET /v1/runs`

List all runs (active and completed).

**Response:**
```json
{
  "runs": [
    {
      "id": "a1b2c3d4-...",
      "workflow_type": "dayzero",
      "engagement_mode": "turnaround_diagnostic",
      "status": "running",
      "started_at": "2026-03-10T07:30:00.000Z",
      "message_count": 5
    }
  ]
}
```

### `GET /v1/runs/:id`

Get status and agent messages for a specific run.

**Response:**
```json
{
  "id": "a1b2c3d4-...",
  "workflow_type": "dayzero",
  "engagement_mode": "turnaround_diagnostic",
  "status": "running",
  "started_at": "2026-03-10T07:30:00.000Z",
  "message_count": 3,
  "messages": [
    { "text": "Starting Phase 0: Orient...", "timestamp": "2026-03-10T07:30:15.000Z" },
    { "text": "Orientation package complete.", "timestamp": "2026-03-10T07:45:00.000Z" }
  ]
}
```

### `POST /v1/runs/:id/complete`

Mark a run as completed.

**Response:**
```json
{
  "status": "completed",
  "run_id": "a1b2c3d4-..."
}
```

## Output

Assessment artifacts are written by the agent to:
```
/workspace/extra/workflows/runs/{workflow_type}_{run_id_prefix}/
```

For DayZero workflows, this follows the standard run structure:
```
runs/{workflow_type}_{run_id}/
  phase_0_orient/
    orientation_package.yaml
  phase_1_quantify/
    quantified_baseline.yaml
    findings/F_1001.yaml, ...
  phase_2_compare/
    discrepancy_register.yaml
    findings/F_2001.yaml, ...
  phase_3_connect/
    thread_map.yaml
    findings/F_3001.yaml, ...
  assessment_summary.md
  delivery/
    primer.md
    assessment_workbook.xlsx
```

## Example Usage

```bash
# Start a DayZero turnaround diagnostic
curl -X POST http://localhost:9002/v1/run \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: your-api-key" \
  -d '{"workflow_type": "dayzero"}'

# Start with Geodesic workflow tracking
curl -X POST http://localhost:9002/v1/run \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: your-api-key" \
  -d '{"workflow_type": "dayzero", "workflow_run_id": "uuid", "tenant_id": "uuid", "workspace_id": "uuid"}'

# Poll for progress
curl -H "X-Api-Key: your-api-key" http://localhost:9002/v1/runs/<run_id>

# List all runs
curl -H "X-Api-Key: your-api-key" http://localhost:9002/v1/runs

# Mark complete
curl -X POST -H "X-Api-Key: your-api-key" http://localhost:9002/v1/runs/<run_id>/complete
```
