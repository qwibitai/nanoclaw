# OneCLI Secrets Reference

Generated 2026-05-12 — refresh when you add/remove a secret. Source of truth is `onecli secrets list`; this doc just captures it in a form that's grep-able and reviewable at a glance.

## How it works

Agent containers don't see raw credentials. Every outbound HTTPS request from a container goes through the OneCLI proxy (with the bundled CA cert installed in the container's trust store). The proxy looks at the request's host (and optionally path) and, if it matches a secret's `hostPattern` (and `pathPattern`, when set) **and** the calling agent is allowed to use that secret (per its secret mode), it injects the configured header (`headerName` + `valueFormat`) before forwarding. The agent code never reads the credential — it just makes the API call as if no auth were needed.

Two ACL layers gate injection:

1. **Per-secret `hostPattern` / `pathPattern`** — request must match for the secret to even be a candidate. `hostPattern` matches the API endpoint host, **not** a workspace URL or browser URL. For Slack, that means `slack.com` for the Web API, even when the workspace lives at `acme.slack.com`. For Google APIs, `*.googleapis.com`, never `mail.google.com`.
2. **Per-agent secret mode** — `mode: all` agents get every secret whose host pattern matches; `mode: selective` agents only get secrets explicitly assigned via `onecli agents set-secrets`. New agents are created `selective` and empty (see CLAUDE.md "Gotcha: auto-created agents start in `selective` secret mode").

When neither layer matches, the request goes out unauthenticated and the upstream returns 401. The proxy logs `injection_count=0` for that case — the fastest signal that a secret didn't fire.

## Secrets

| Name | hostPattern | pathPattern | Header | Value format | Consumer agent(s) | Notes |
|------|-------------|-------------|--------|--------------|-------------------|-------|
| `FIRECRAWL` | `*.firecrawl.dev` | — | `Authorization` | `Bearer {value}` | Zed (mode=all), Default | Web scrape/crawl API |
| `SERPER` | `*.serper.dev` | — | `Authorization` | `Bearer {value}` | Zed, Default | Google SERP API |
| `PARALLEL_SEARCH` | `*.parallel.ai` | — | `Authorization` | `Bearer {value}` | Zed, Default | Parallel.ai search |
| `SLACK_TOKEN_DGG` | `slack.com` | — | `Authorization` | `Bearer {value}` | Zed, Default | DemandGenGuy workspace; uses bare `slack.com` (Web API host) |
| `SLACK_TOKEN_MILLER7` | `millermedia7.slack.com` | — | `Authorization` | `Bearer {value}` | Zed, Default | Workspace-scoped — see Quirks for caveat |
| `SLACK_TOKEN_CACHE` | `usecache.slack.com` | — | `Authorization` | `Bearer {value}` | Zed, Default | Workspace-scoped — see Quirks for caveat |
| `SLACK_TOKEN_MEADOW` | `meadowglobal.slack.com` | — | `Authorization` | `Bearer {value}` | Zed, Default | Workspace-scoped — see Quirks for caveat |
| `ROYAL_MCP_FALCONE` | `falconeglobal.com` | `/wp-json/royal-mcp/*` | `X-Royal-MCP-API-Key` | `{value}` | Falcone (selective), Zed, Default | NOT `Authorization: Bearer` — Royal MCP uses its own header |
| `HOME_ASSISTANT` | `n9tlvwffai1fg24p4ij4zklla4fwlf2y.ui.nabu.casa` | `/api/mcp` | `Authorization` | `Bearer {value}` | Home (selective), Zed, Default | Nabu Casa cloud relay; path-scoped to MCP endpoint |
| `N8N_API_KEY` | `100.69.48.89` | — | `X-N8N-API-KEY` | `{value}` | Zed, Default | Tailscale IP; see Quirks re: ports |
| `SOLIDTIME_TOKEN` | `100.69.48.89` | `/api/*` | `Authorization` | `Bearer {value}` | Zed, Default | Same host as N8N, disambiguated by pathPattern |
| `LINEAR_API_KEY` | `api.linear.app` | — | `Authorization` | `Bearer {value}` | Zed, Default | |
| `HUBSPOT_ACCESS_TOKEN_M7_PAT` | `api.hubapi.com` | — | `Authorization` | `Bearer {value}` | Zed, Default | MillerMedia7 portal PAT |
| `Brave Search` | `api.search.brave.com` | — | `X-Subscription-Token` | `{value}` | Zed, Default | Subscription token, not Bearer |
| `Google: jaybhess@gmail.com` | `*.googleapis.com` | — | `X-GWS-Refresh` | `{value}` | Zed, Default | gws CLI swaps refresh→access token via OAuth Client |
| `Google: bradhess@usecache.com` | `*.googleapis.com` | — | `X-GWS-Refresh` | `{value}` | Zed, Default | gws account |
| `Google: brad@millermedia7.com` | `*.googleapis.com` | — | `X-GWS-Refresh` | `{value}` | Zed, Default | gws account |
| `Google: brad@meadowfi.com` | `*.googleapis.com` | — | `X-GWS-Refresh` | `{value}` | Zed, Default | gws account |
| `Google: brad@demandgenguy.com` | `*.googleapis.com` | — | `X-GWS-Refresh` | `{value}` | Zed, Default | gws account |
| `Google OAuth Client` | `oauth2.googleapis.com` | — | `X-GWS-Client` | `{value}` | Zed, Default | Client ID + secret for refresh-token exchange |

**Consumer column convention.** `mode: all` agents (Zed, Default) are listed even though they automatically receive every matching secret — useful for confirming "yes, this agent will see it." Other groups are `mode: selective` and only appear when explicitly assigned via `onecli agents set-secrets` (verify with `onecli agents secrets --id <agent-id>`).

Current `mode: selective` assignments:
- **Falcone** → `ROYAL_MCP_FALCONE`
- **Home** → `HOME_ASSISTANT`
- **Wiki, Ads, writer-h1, writer-h2, whatsapp-home, whatsapp-main** → none of the above; selective with no live vault secrets assigned (their work is host-mediated, not direct API).

## Known quirks

- **OneCLI `hostPattern` silently rejects `host:port`.** Patterns like `100.69.48.89:5678` or `100.69.48.89:8088` look correct in the UI but never match; the proxy logs `injection_count=0`. Use the bare host (`100.69.48.89`) and disambiguate co-resident services with `pathPattern` instead (see `N8N_API_KEY` vs `SOLIDTIME_TOKEN`, both on `100.69.48.89`).
- **`onecli secrets create` silently drops `--header-name` and `--value-format`.** As of the current CLI build, custom injection config submitted on `create` is discarded — the secret is created with defaults and then needs a follow-up `onecli secrets update --id <id> --header-name ... --value-format ...`. Always verify with `onecli secrets list` after creating a non-Bearer secret. Affected secrets to double-check after any vault rebuild: `ROYAL_MCP_FALCONE` (`X-Royal-MCP-API-Key`), `N8N_API_KEY` (`X-N8N-API-KEY`), `Brave Search` (`X-Subscription-Token`), all four `Google: <email>` entries (`X-GWS-Refresh`), `Google OAuth Client` (`X-GWS-Client`).
- **Slack `hostPattern` must match the Web API host.** Bot/user tokens hit `https://slack.com/api/...`, not `https://<workspace>.slack.com/...`. `SLACK_TOKEN_DGG` is correctly set to `slack.com`; the three workspace-host entries (`millermedia7.slack.com`, `usecache.slack.com`, `meadowglobal.slack.com`) only match if MCP/agent code happens to hit those hosts directly. If a Slack call returns 401 with `injection_count=0`, the hostPattern is the first thing to check — the fix is usually to change it to `slack.com` and let the bearer token itself scope the workspace.
- **`Authorization: Bearer` is OAuth-only.** WordPress Royal MCP (and similar custom APIs) use a custom header. `ROYAL_MCP_FALCONE` uses `X-Royal-MCP-API-Key` with `valueFormat: {value}` (no `Bearer` prefix). Recreating it with `Authorization: Bearer {value}` looks "more standard" but breaks the integration.
- **Zed needs `mode: all`.** Zed is Brad's main DM agent and routinely calls every integration. Other groups stay `selective` for blast-radius reasons (notably Ads, which never calls APIs directly — its credentials live in MCP config in `~/.config/gws/`, LinkedIn's own token file, etc.).
- **Auto-created agents start empty.** When a new agent group is first spawned, `container-runner.ts` calls `onecli.ensureAgent()`, which creates the agent in `selective` mode with **no secrets assigned**. Symptom: container starts cleanly, proxy + CA are wired, yet API calls return 401. Fix is either `onecli agents set-secret-mode --mode all` (for trusted groups) or `onecli agents set-secrets --secret-ids ...` (for selective groups). See CLAUDE.md.

## Refresh procedure

```bash
# Dump current vault state (no secret values, just metadata)
onecli secrets list

# Per-agent assignments for selective-mode agents
onecli agents list
onecli agents secrets --id <agent-id>
```

Update the table above to match. Bump the "Generated" date at the top. Never paste raw secret values into this file.
