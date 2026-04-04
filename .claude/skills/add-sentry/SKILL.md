---
name: add-sentry
description: Add Sentry integration (issue lookup, event search, project management) via IPC bridge. Gives agents tools to list projects, search/resolve/ignore/assign issues, and inspect events.
---

# Add Sentry Integration

This skill adds Sentry issue management to NanoClaw via the IPC bridge pattern.

## What It Provides

- **list_projects** -- List all Sentry projects in the organization
- **list_issues** -- Search and filter issues by project, query, sort, and limit
- **get_issue** -- Get full details for a single issue
- **get_events** -- Get latest event occurrences for an issue
- **resolve_issue** -- Mark an issue as resolved
- **ignore_issue** -- Ignore an issue
- **assign_issue** -- Assign an issue to a user

## Credentials

The Sentry auth token is resolved in this order:

1. **Environment variable**: `SENTRY_AUTH_TOKEN`
2. **macOS Keychain**: service `nanoclaw`, account `sentry-auth-token`

To store the token in Keychain:

```bash
security add-generic-password -s nanoclaw -a sentry-auth-token -w "<your-token>"
```

## Configuration

The wrapper reads `org` and `baseUrl` from `config/private.yaml` (loaded by `scripts/load_private_config.py`):

```yaml
sentry:
  org: your-org-slug
  baseUrl: https://sentry.io
```

## Architecture

- `scripts/sentry_wrapper.py` -- Host-side Python wrapper that calls the Sentry API
- `src/sentry-ipc.ts` -- Host-side IPC handler that bridges container requests to the wrapper
- `container/agent-runner/src/sentry-mcp-stdio.ts` -- Container-side MCP server exposing tools to agents
- IPC directories: `{group}/sentry/requests/` and `{group}/sentry/responses/`

## Skill Type

Feature skill -- merged from the `skill/sentry` branch.
