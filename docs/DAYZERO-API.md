# DayZero API

HTTP API for triggering DayZero assessment runs via NanoClaw.

## Overview

The DayZero channel exposes an HTTP server (default port `9002`) that accepts
requests to run evidence-based company assessments. Each request spawns a
NanoClaw container agent that executes the DayZero framework against a
company's data package.

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `DAYZERO_PORT` | `9002` | HTTP port for the DayZero API |

### Prerequisites

- DayZero repo cloned at `/root/geodesic-explore/DayZero`
- Mount allowlist (`~/.config/nanoclaw/mount-allowlist.json`) includes `/root/geodesic-explore` as an allowed root
- Group `internal:dayzero` registered in the NanoClaw database
- Company data packages present at `DayZero/data/{company}/`

## Endpoints

### `GET /health`

Returns API status and active runs.

**Response:**
```json
{
  "status": "ok",
  "active_runs": 1,
  "runs": [
    { "id": "a1b2c3d4", "company": "point_b" }
  ]
}
```

### `POST /v1/run`

Start a new DayZero assessment.

**Request body:**
```json
{
  "company": "point_b",
  "engagement_mode": "turnaround_diagnostic",
  "phase": "phase_2"
}
```

| Field | Required | Default | Description |
|---|---|---|---|
| `company` | Yes | — | Company name (must match a directory in `DayZero/data/`) |
| `engagement_mode` | No | `turnaround_diagnostic` | Either `turnaround_diagnostic` or `carveout_separation` |
| `phase` | No | — | Resume from a specific phase instead of starting from Phase 0 |

**Response:**
```json
{
  "status": "started",
  "run_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "company": "point_b",
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
      "company": "point_b",
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
  "company": "point_b",
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
/root/geodesic-explore/DayZero/runs/{company}_{run_id_prefix}/
```

This follows the standard DayZero run structure:
```
runs/{company}_{run_id}/
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
# Start a turnaround diagnostic
curl -X POST http://localhost:9002/v1/run \
  -H "Content-Type: application/json" \
  -d '{"company": "point_b"}'

# Poll for progress
curl http://localhost:9002/v1/runs/<run_id>

# List all runs
curl http://localhost:9002/v1/runs

# Mark complete
curl -X POST http://localhost:9002/v1/runs/<run_id>/complete
```

## Security

**WARNING: The DayZero API has no authentication.** Any client that can reach
port 9002 can trigger assessment runs. This is acceptable when:

- The server is behind a firewall or security group restricting access
- The port is bound to localhost only (`DAYZERO_PORT=127.0.0.1:9002` — not yet supported, would require a code change)
- Access is mediated by a reverse proxy with authentication (e.g., nginx + OAuth2 Proxy)

The same limitation applies to the Geodesic channel on port 9001.

If the server is internet-facing, consider:
1. Firewall rules restricting access to known IPs
2. A reverse proxy (nginx/Caddy) with bearer token or mTLS authentication
3. Binding to localhost and using an SSH tunnel for remote access
