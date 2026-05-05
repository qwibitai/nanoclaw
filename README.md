<h1 align="center">

<a href="https://www.socfortress.co"><img src="assets/talon-final-1024.png" alt="Talon" width="400"></a>

Talon

[![Medium](https://img.shields.io/badge/Medium-12100E?style=for-the-badge&logo=medium&logoColor=white)](https://socfortress.medium.com/)
[![YouTube Channel Subscribers](https://img.shields.io/youtube/channel/subscribers/UC4EUQtTxeC8wGrKRafI6pZg)](https://www.youtube.com/@taylorwalton_socfortress/videos)
[![Discord Shield](https://discordapp.com/api/guilds/871419379999469568/widget.png?style=shield)](https://discord.gg/UN3pNBzaEQ)
[![GitHub Sponsors](https://img.shields.io/badge/sponsor-30363D?style=for-the-badge&logo=GitHub-Sponsors&logoColor=#EA4AAA)](https://github.com/sponsors/taylorwalton)

[![Get in Touch](https://img.shields.io/badge/📧%20Get%20in%20Touch-Friendly%20Support%20Awaits!-blue?style=for-the-badge)](https://www.socfortress.co/contact_form.html)

</h1>

<h4 align="center">

Talon is an automated AI SOC analyst built by <a href="https://www.socfortress.co">SOCfortress</a> for the <a href="https://github.com/socfortress/CoPilot">CoPilot</a> stack. It runs as a background service alongside CoPilot — pulling raw events from your Wazuh/OpenSearch SIEM, enriching them with threat intelligence, correlating across your environment, and writing structured investigation reports with severity assessments and recommended actions directly back into CoPilot.

📚 <strong>Docs:</strong> <a href="https://docs.socfortress.co">docs.socfortress.co</a>

</h4>

---

---

## What It Does

- **Automated Tier 1 investigations** — every OPEN alert is investigated end-to-end: SIEM raw event → IOC extraction → VirusTotal / Shodan / AbuseIPDB → MITRE ATT&CK correlation → structured report
- **Two trigger paths** — real-time via `POST /investigate` (CoPilot calls this when an alert is created) and a 15-minute scheduled sweep as a safety net
- **Writes back to CoPilot** — job status, full report, and enriched IOCs are persisted in CoPilot's database via its REST API; no direct database writes
- **Privacy-aware by default** — an anonymizing MCP proxy intercepts raw SIEM events and replaces PII (usernames, hostnames, internal IPs) with session tokens before they reach the cloud model; a built-in `deanonymize` tool restores real values in the final report
- **Optional local LLM analysis** — if [Ollama](https://ollama.com) is running, the agent routes raw event interpretation through a local model instead of the cloud; no config needed if Ollama is on the same host
- **Alert-type prompt templates** — per-alert-type investigation guides (Sysmon Event 1, 3, 7, 11, 22) are loaded automatically based on the alert's `rule.groups` field; add new templates without touching code

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                 CoPilot (FastAPI)                    │
│                                                      │
│  Alert created → POST /investigate ──────────────┐   │
│  GET /status, GET /jobs/:alertId ← Talon HTTP API │   │
│                                                   │   │
│  Write-back API (MCP tools):                      │   │
│    POST /api/ai_analyst/jobs          ←───────────┘   │
│    POST /api/ai_analyst/reports                       │
│    POST /api/ai_analyst/iocs                          │
│  MySQL: ai_analyst_job / report / ioc                 │
└───────────────────────┬───────────────────────────────┘
                        │ read-only MCP        ▲ REST write-back
                        ▼                      │
┌─────────────────────────────────────────────────────┐
│                   Talon (Node.js)                    │
│                                                      │
│  HTTP channel (port 3100)                            │
│    POST /investigate  ← CoPilot triggers this        │
│    POST /message      ← ad-hoc analyst prompts       │
│    GET  /status       ← queue + job overview         │
│    GET  /jobs/:id     ← per-alert report status      │
│    GET  /health                                      │
│                                                      │
│  Scheduled task (every 15 min)                       │
│    Queries MySQL for OPEN alerts with no job row     │
│    Runs full investigation per alert                 │
│                                                      │
│  SOC agent container                                 │
│    groups/copilot/CLAUDE.md  ← investigation flow    │
│    groups/copilot/prompts/   ← per-alert templates   │
└─────────────────────────────────────────────────────┘
         │ MCP tools (read-only)
         ▼
┌────────────────────────────────────────────────────────────┐
│  opensearch-mcp     — raw SIEM queries                     │
│  opensearch_anon    — anonymizing proxy (PII → tokens)     │
│  mysql-mcp          — CoPilot DB (alerts, assets, agents)  │
│  copilot-mcp        — CoPilot REST API write-back          │
│  wazuh-mcp          — Wazuh manager API (agents, rules, SCA) │
│  velociraptor-mcp   — Velociraptor DFIR (artifacts, VQL, collections) │
│  shuffle-mcp        — Shuffle SOAR catalog (3,000+ apps, agent runs) │
│  cve-mcp            — CVE/EPSS/KEV + IOC enrichment (27 tools, 21 sources) │
│  ollama (optional)  — local LLM for sensitive event data   │
└────────────────────────────────────────────────────────────┘
```

For the full architecture and design decisions, see:
- [docs/COPILOT_INTEGRATION.md](docs/COPILOT_INTEGRATION.md) — trigger paths, MySQL schema, MCP tool reference, implementation roadmap
- [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) — design philosophy and architecture decisions

---

## Privacy & Anonymization

Raw SIEM events contain sensitive data — usernames, internal hostnames, RFC1918 IPs. Talon's anonymizing MCP proxy intercepts all document and search results before they reach the Claude cloud API and replaces known PII fields with consistent session tokens:

| Token | Replaces |
|---|---|
| `USER_1`, `USER_2`, … | Usernames, account names (`data_win_eventdata_user`, etc.) |
| `HOST_1`, `HOST_2`, … | Hostnames, computer names (`agent_name`, etc.) |
| `IP_INT_1`, … | Internal / RFC1918 IP addresses |
| `EMAIL_1`, … | Email addresses |

Security-critical values — file hashes, external IPs, domains, process paths, rule metadata — pass through unchanged so threat intel lookups work normally. Before the final report is written, the agent calls a built-in `deanonymize` tool to restore real names and IPs so the analyst sees accurate output.

Field definitions live in [`siem/anon_proxy/fields.yaml`](siem/anon_proxy/fields.yaml) — add new fields and `git pull` to distribute to all deployments.

See [docs/ANON_PROXY.md](docs/ANON_PROXY.md) for a full walkthrough of the proxy flow.

---

## Local LLM Support (Ollama)

Two distinct Ollama integrations, used independently or together:

**1. IOC extraction tool (existing)** — when an investigation runs, the agent routes raw-event interpretation through a local Ollama model so the full event JSON never leaves the host. The cloud agent still runs the investigation; Ollama just handles the "extract IOCs from this raw blob" step. Auto-detected at startup; no `.env` required for same-machine installs. See step 14 of the deployment guide.

**2. Agent runtime replacement (air-gapped mode, new)** — replace the **entire Claude Agent runtime** with a local Ollama instance via four `.env` lines. The Claude Agent SDK is redirected at Ollama via `ANTHROPIC_BASE_URL`; Ollama 0.4+ speaks the Anthropic v1/messages API natively. No traffic to `api.anthropic.com`. Suitable for fully air-gapped or compliance-driven deployments.

```bash
TALON_PROVIDER=ollama
TALON_OLLAMA_BASE_URL=http://host.docker.internal:11434
TALON_OLLAMA_MODEL=llama3.3:70b
TALON_OLLAMA_API_KEY=ollama
```

Restart Talon and every group inherits the provider. Default mode (no env vars) keeps using Anthropic Claude. See [docs/PROVIDER_SELECTION.md](docs/PROVIDER_SELECTION.md) for model picker, latency expectations (~60-100s/turn vs 3-15s on Anthropic), and troubleshooting. Practical model floor for full Talon scaffolding is 32B; 70B recommended.

---

## Deployment Guide

### Prerequisites

- Docker
- Node.js 20+
- A running OpenSearch / Wazuh SIEM
- A running CoPilot instance (MySQL/MariaDB + FastAPI)
- A [Claude Code](https://claude.ai/download) OAuth token

### 1. Clone and install

```bash
git clone https://github.com/taylorwalton/talon.git talon
cd talon
npm install && npm run build
```

### 2. Get a Claude OAuth token

```bash
claude setup-token
# Copy the sk-ant-oat01-... token that is printed
```

### 3. Create `.env`

```bash
cat > .env <<EOF
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...

# Optional: webhook endpoint for the 15-minute SOC alert digest
# WEBHOOK_URL=https://your-endpoint.example.com/talon-digest
# WEBHOOK_SECRET=optional-bearer-token

# Required: API key for all HTTP channel requests (except /health)
HTTP_API_KEY=your-secret-key-here

# Optional: restrict the native credential-proxy fallback to loopback only
# (only used when OneCLI is unavailable; default: 0.0.0.0)
# CREDENTIAL_PROXY_HOST=127.0.0.1

# Optional: agent runtime provider. Default is 'anthropic' (Claude via OneCLI).
# Set to 'ollama' for fully air-gapped operation. See docs/PROVIDER_SELECTION.md
# and .env.provider.example for model recommendations and latency expectations.
# TALON_PROVIDER=ollama
# TALON_OLLAMA_BASE_URL=http://host.docker.internal:11434
# TALON_OLLAMA_MODEL=llama3.3:70b
# TALON_OLLAMA_API_KEY=ollama
EOF
```

> **Note:** `CLAUDE_CODE_OAUTH_TOKEN` is required here so the OneCLI migration in step 5 can pick it up. After that step strips it from `.env`, the token lives only in the OneCLI Vault.

### 4. Install OneCLI (recommended)

Install the OneCLI gateway and bootstrap a per-group agent identity. OneCLI manages the Anthropic credential (and optionally other backend credentials) so they never enter agent containers — auth is injected at the network layer via an HTTPS proxy.

```bash
bash scripts/install-onecli.sh
```

What it does (idempotent — safe to re-run):

- Installs the OneCLI Docker stack and CLI binary if missing
- Probes the gateway URL (Docker bridge IP on Linux, loopback on macOS)
- Detects groups under `groups/` and creates a OneCLI agent for each one (excluding `main`, which uses OneCLI's default agent)
- Persists `ONECLI_URL` and `ONECLI_API_KEY` to `.env`

If you skip this step, Talon falls back to injecting `CLAUDE_CODE_OAUTH_TOKEN` directly into the container as an env var. The fallback works in most cases, but in some environments the in-container Claude CLI requires a manual `claude /login` to bootstrap on first run. With OneCLI present, that manual step is never needed.

### 5. Migrate the Anthropic credential to the OneCLI Vault

After OneCLI is running, register your Claude OAuth token (or API key) in the Vault:

```bash
bash scripts/migrate-anthropic-to-vault.sh
```

This reads `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) from `.env` and registers it as an `anthropic` secret bound to `api.anthropic.com`. The raw token stays in `.env` for now so you can verify the Vault path works first.

Restart Talon and confirm with:

```bash
sudo systemctl restart talon
grep -E 'OneCLI gateway|Injecting' logs/talon.log | tail
```

You should see `OneCLI gateway config applied` and **not** `Injecting CLAUDE_CODE_OAUTH_TOKEN into container`. Once verified, strip the raw token from `.env`:

```bash
bash scripts/migrate-anthropic-to-vault.sh --strip-env
sudo systemctl restart talon
```

### 6. Create the mount allowlist

Controls which host directories can be mounted into agent containers. Lives outside the project root so agents cannot modify it.

**Run this from your Talon installation directory** (e.g. `/opt/talon`) so `$(pwd)` resolves correctly:

```bash
mkdir -p ~/.config/nanoclaw
TALON_DIR=$(pwd)
cat > ~/.config/nanoclaw/mount-allowlist.json <<EOF
{
  "allowedRoots": [
    {
      "path": "${TALON_DIR}/mempalace-data",
      "allowReadWrite": true,
      "description": "MemPalace palace data — writable so the agent can persist investigation memories"
    },
    {
      "path": "${TALON_DIR}",
      "allowReadWrite": false,
      "description": "Talon project root"
    }
  ],
  "blockedPatterns": [],
  "nonMainReadOnly": false
}
EOF
```

> **Order matters:** the `mempalace-data` entry must come before the project root entry — the security layer matches the first applicable root. If all MCP tools are unavailable after starting Talon, this file is the first thing to check.

### 7. Configure SIEM credentials

```bash
bash siem/setup.sh
# Edit siem/.env — set OPENSEARCH_HOSTS, OPENSEARCH_USERNAME, OPENSEARCH_PASSWORD
```

The setup script creates the Python venv and installs `opensearch-mcp-server` into it. The `.env` file is created from the template automatically if it doesn't already exist.

### 8. Configure MySQL credentials

```bash
bash mysql/setup.sh
# Edit mysql/.env — set MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASS, MYSQL_DB
```

### 9. Configure CoPilot MCP credentials

```bash
bash copilot-mcp/setup.sh
# Edit copilot-mcp/.env — set COPILOT_URL, COPILOT_USERNAME, COPILOT_PASSWORD
```

> **Note:** If CoPilot is on the same host as Talon, use `host.docker.internal` instead of `127.0.0.1`:
> ```
> COPILOT_URL=http://host.docker.internal:5000
> ```

### 10. Configure Wazuh MCP credentials

```bash
bash wazuh-mcp/setup.sh
# Edit wazuh-mcp/.env — set WAZUH_PROD_URL, WAZUH_PROD_USERNAME, WAZUH_PROD_PASSWORD
```

The Wazuh MCP server gives the agent direct access to the Wazuh manager API — querying agent inventory, network connections, installed packages, running processes, SCA results, and security rules. Credentials must be for a Wazuh user with at least read-only API access.

> **Note:** The default Wazuh manager API port is `55000`. If the manager is on the same host as Talon, use `host.docker.internal`:
> ```
> WAZUH_PROD_URL=https://host.docker.internal:55000
> ```
> Set `WAZUH_PROD_SSL_VERIFY=false` if the manager uses a self-signed certificate.

### 11. Configure Velociraptor MCP credentials

```bash
bash velociraptor-mcp/setup.sh
```

Then copy your Velociraptor API config into the directory:

```bash
# On your Velociraptor server, generate a client config:
velociraptor config api_client --name talon > api.config.yaml
# Then copy it to your Talon install:
cp api.config.yaml velociraptor-mcp/api.config.yaml
```

The Velociraptor MCP server gives the agent direct DFIR capability — querying client inventory, running VQL queries, listing and collecting artifacts (Windows and Linux), and retrieving collection results. The `VELOCIRAPTOR_API_KEY` in `.env` is set to `api.config.yaml` by default; the wrapper script resolves it to an absolute path automatically, so the same `.env` works on both the host and inside the container.

> **Note:** Set `VELOCIRAPTOR_SSL_VERIFY=false` in `velociraptor-mcp/.env` if your Velociraptor server uses a self-signed certificate.

### 12. Configure Shuffle MCP credentials (optional)

```bash
bash shuffle-mcp/setup.sh
# Edit shuffle-mcp/.env — set SHUFFLE_URL and SHUFFLE_API_KEY
```

The Shuffle MCP server gives the agent interactive access to Shuffle's 3,000+ SaaS app catalog — `RunAppAgentTool` and `GetExecutionResultTool` for natural-language driving of any authenticated app, plus `AuthenticateTool` and `GetAppsTool` for discovery. Use it for mid-investigation tool calls (e.g. "look up this user's email via Outlook search," "post a Slack thread to #soc," "open a Jira ticket"). This is separate from CoPilot's notification-dispatch path — that path goes through `mcp__copilot__DispatchNotificationsTool`.

> **Note:** Cloud users typically set `SHUFFLE_URL=https://shuffler.io`. Self-hosted users use their own region/instance. The `SHUFFLE_API_KEY` should be the same admin-scoped key configured in CoPilot's Shuffle connector. Skip this step if you don't use Shuffle — Talon will start without the MCP and continue with the other tools.

### 13. Configure CVE MCP credentials (optional)

```bash
bash cve-mcp/setup.sh
# Edit cve-mcp/.env — at minimum set NVD_API_KEY (free signup)
```

The CVE MCP server ([source](https://github.com/mukul975/cve-mcp-server)) provides 27 security intelligence tools across 21 data sources — CVE/EPSS/KEV/CVSS lookups, exploit availability, MITRE ATT&CK techniques, IP reputation (AbuseIPDB, GreyNoise, Shodan), threat intel (VirusTotal, urlscan, MalwareBazaar), and GitHub advisories. These replace the `WebFetch`/`WebSearch` scrapes Talon previously used for IOC enrichment with native, structured, cached calls.

The MCP works **without any keys** but rate-limits aggressively (NVD: 5 req/30s, GitHub: 60/hr). With a free `NVD_API_KEY` and `GITHUB_TOKEN`, rates rise to 50 req/30s and 5,000/hr respectively. Optional Tier 2 keys (`VIRUSTOTAL_KEY`, `SHODAN_KEY`, `ABUSEIPDB_KEY`, etc.) unlock commercial threat intel data sources.

> **Note:** Skip this step if you don't need CVE/IOC enrichment — Talon will start without the MCP and fall back to its existing `WebFetch`/`WebSearch` flow. NVD signup is free at [nvd.nist.gov/developers/request-an-api-key](https://nvd.nist.gov/developers/request-an-api-key).

### 14. Configure local LLM analysis (optional)

Talon can route raw SIEM event analysis through an open-source LLM instead of the Claude cloud model. Combined with the anonymizing proxy — which replaces PII with session tokens before any LLM call — this keeps sensitive data interpretation off Anthropic's API entirely.

If no LLM is configured, the agent skips local analysis silently and continues the investigation without it.

There are two ways to run the LLM:

---

#### Option A — Local Ollama (on-premises, best privacy)

Install [Ollama](https://ollama.com) on the same machine as Talon and pull a model:

```bash
ollama pull qwen2.5:7b    # recommended — strong analytical capability
# or: ollama pull mistral:7b
# or: ollama pull llama3.2:3b  (lighter, faster)
```

No `.env` is needed for same-machine installs — the agent container reaches Ollama automatically via `host.docker.internal:11434`. If Ollama is running on a **different host**, create the config file:

```bash
cp ollama/.env.example ollama/.env
# Edit ollama/.env — set OLLAMA_HOST=http://<host>:11434
```

**Best for:** clients with an existing GPU server or workstation.

---

#### Option B — RunPod cloud GPU (no hardware required)

[RunPod](https://www.runpod.io) lets you run open-source models on cloud GPUs and pay only for what you use. Because Talon's anonymizing proxy has already replaced PII with tokens before the LLM call, what RunPod sees is desensitised data — not real usernames, hostnames, or internal IPs.

**Recommended: RunPod Pod** — persistent GPU instance with no cold start. Stop the pod when not in use (you only pay for storage at ~$0.20/month while stopped).

1. Create a RunPod account at [runpod.io](https://www.runpod.io)
2. Deploy a pod using the **Ollama NVIDIA CUDA** template
   - GPU: `RTX 3090` or `RTX 4090` recommended
   - Expose port `11434` via HTTP proxy
   - Your endpoint will be: `https://<pod-id>-11434.proxy.runpod.net`
3. SSH into the pod and pull your chosen model:
   ```bash
   ollama pull qwen2.5:7b
   ```
4. Point Talon at the RunPod endpoint — note this goes in `ollama/.env`, **not** the root `.env`:
   ```bash
   echo 'OLLAMA_HOST=https://<pod-id>-11434.proxy.runpod.net' > ollama/.env
   ```

**Best for:** clients without GPU hardware who still want open-source model analysis.

| | Local Ollama | RunPod Serverless | RunPod Persistent Pod |
|---|---|---|---|
| Hardware required | Yes (GPU) | No | No |
| Running cost | $0 (sunk) | Pay per investigation | ~$0.20–0.44/hr |
| Cold start | None | ~30–60s | None |
| Privacy | Best (fully on-prem) | Good (PII already tokenized) | Good (PII already tokenized) |
| Best for | Existing GPU infra | Most clients | High-volume SOCs |

---

### 15. Set up MemPalace persistent memory

MemPalace gives the SOC agent long-term memory — past investigation outcomes, asset metadata, confirmed false positives, and IOC history are stored in a local ChromaDB + SQLite knowledge graph and retrieved automatically at the start of each investigation.

```bash
bash mempalace/setup.sh
```

If the build fails try installing the C++ complier and build tools:

```bash
apt install -y build-essential g++ python3-dev
```

This creates the local venv and the `mempalace-data/` directory where the palace is stored. The palace initialises automatically on first agent run — no separate init step is needed.

> **Note:** `mempalace-data/` is gitignored and persists across container restarts. The writable mount entry added in Step 6 is what allows the agent to write to it. Back up `mempalace-data/` alongside your other `.env` files.

### 16. Build the container

```bash
CONTAINER_RUNTIME=docker ./container/build.sh
```

### 17. Start the service

**macOS:**
```bash
sed -e "s|{{NODE_PATH}}|$(which node)|g" \
    -e "s|{{PROJECT_ROOT}}|$(pwd)|g" \
    -e "s|{{HOME}}|$HOME|g" \
    launchd/com.nanoclaw.plist > ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

**Linux (system service):**
```bash
mkdir -p logs
cat > /etc/systemd/system/talon.service <<EOF
[Unit]
Description=Talon SOC Analyst
After=network.target

[Service]
Type=simple
ExecStart=$(which node) $(pwd)/dist/index.js
WorkingDirectory=$(pwd)
Restart=always
RestartSec=5
KillMode=process
Environment=HOME=$HOME
Environment=PATH=/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin
StandardOutput=append:$(pwd)/logs/talon.log
StandardError=append:$(pwd)/logs/talon.error.log

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now talon
```

**Linux (user service):**
```bash
mkdir -p ~/.config/systemd/user logs
cat > ~/.config/systemd/user/talon.service <<EOF
[Unit]
Description=Talon SOC Analyst
After=network.target

[Service]
Type=simple
ExecStart=$(which node) $(pwd)/dist/index.js
WorkingDirectory=$(pwd)
Restart=always
RestartSec=5
KillMode=process
Environment=HOME=$HOME
Environment=PATH=/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin
StandardOutput=append:$(pwd)/logs/talon.log
StandardError=append:$(pwd)/logs/talon.error.log

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now talon
loginctl enable-linger
```

### 18. Verify

```bash
# /health is unauthenticated
curl http://localhost:3100/health

# All other endpoints require the API key from your .env
export TALON_API_KEY="your-secret-key-here"

# Test SIEM connectivity
curl -s -N -X POST http://localhost:3100/message \
  -H "Content-Type: application/json" \
  -H "x-api-key: $TALON_API_KEY" \
  -d '{"message": "Check cluster health", "sender": "test"}'

# Test CoPilot MCP connectivity
curl -s -N -X POST http://localhost:3100/message \
  -H "Content-Type: application/json" \
  -H "x-api-key: $TALON_API_KEY" \
  -d '{"message": "Use the copilot MCP tool to list all customers.", "sender": "test"}'

# Test Ollama (optional — only if installed)
curl -s -N -X POST http://localhost:3100/message \
  -H "Content-Type: application/json" \
  -H "x-api-key: $TALON_API_KEY" \
  -d '{"message": "List available Ollama models.", "sender": "test"}'
```

---

## Per-Deployment Configuration

| File | Purpose |
|------|---------|
| `siem/.env` | OpenSearch credentials — gitignored |
| `mysql/.env` | CoPilot MySQL credentials — gitignored |
| `copilot-mcp/.env` | CoPilot REST API credentials — gitignored |
| `wazuh-mcp/.env` | Wazuh manager API credentials — gitignored |
| `velociraptor-mcp/.env` | Velociraptor API config path — gitignored |
| `velociraptor-mcp/api.config.yaml` | Velociraptor API client config — gitignored, copy from server |
| `shuffle-mcp/.env` | Shuffle SOAR API credentials — gitignored, optional |
| `cve-mcp/.env` | CVE MCP API keys (NVD, GitHub, VirusTotal, etc.) — gitignored, optional |
| `ollama/.env` | Optional Ollama host override — gitignored, omit if using defaults |
| `mempalace-data/` | MemPalace palace data (ChromaDB + SQLite) — gitignored, back up separately |
| `.env` | `CLAUDE_CODE_OAUTH_TOKEN`, `WEBHOOK_URL`, `WEBHOOK_SECRET` — gitignored |
| `groups/copilot/CLAUDE.md` | SOC agent identity, known assets, ongoing investigations |
| `groups/copilot/prompts/` | Per-alert-type investigation templates (e.g. `sysmon_event_1.txt`) |
| `siem/anon_proxy/fields.yaml` | PII field definitions for the anonymizing proxy |
| `~/.config/nanoclaw/mount-allowlist.json` | Mount security policy — outside repo, tamper-proof |

Append client-specific context (asset inventory, known-good IP ranges, crown jewel assets, business hours) to the bottom of `groups/copilot/CLAUDE.md`.

---

## Adding Alert-Type Templates

Investigation templates live in `groups/copilot/prompts/`. Each file is a plain-text guide with template variables that the agent fills in at runtime.

| File | Alert type |
|------|-----------|
| `sysmon_event_1.txt` | Process Creation (Sysmon Event 1) |
| `sysmon_event_3.txt` | Network Connection (Event 3) |
| `sysmon_event_7.txt` | Image Load / DLL (Event 7) |
| `sysmon_event_11.txt` | File Create (Event 11) |
| `sysmon_event_22.txt` | DNS Query (Event 22) |

To add a new alert type, create the corresponding `.txt` file — no code changes required. The agent detects the type from `rule.groups` in the raw event and loads the matching template automatically.

---

## Key Source Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: message loop, agent invocation |
| `src/channels/http.ts` | HTTP channel: `/investigate`, `/status`, `/jobs/:id`, `/message` |
| `src/task-scheduler.ts` | 15-minute scheduled alert sweep |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `groups/copilot/CLAUDE.md` | SOC agent investigation workflow |
| `groups/copilot/.mcp.json` | MCP server registry (opensearch, mysql, copilot, wazuh, velociraptor, ollama) |
| `siem/anon_proxy/anon_proxy.py` | Anonymizing MCP proxy |
| `siem/anon_proxy/fields.yaml` | PII field definitions (git-pullable) |
| `container/Dockerfile` | Agent container image |

---

## Documentation

| Doc | Contents |
|-----|---------|
| [docs/COPILOT_INTEGRATION.md](docs/COPILOT_INTEGRATION.md) | Full CoPilot integration architecture, MySQL schema, MCP tool reference, implementation roadmap |
| [docs/ANON_PROXY.md](docs/ANON_PROXY.md) | Anonymizing proxy deep-dive: flow, token types, preserved fields, de-anonymization, extending `fields.yaml` |
| [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) | Design philosophy and architecture decisions |
| [docs/SECURITY.md](docs/SECURITY.md) | Container isolation model and security boundaries |

---

## Help

You can reach us on [Discord](https://discord.gg/UN3pNBzaEQ) or by [📧](mailto:info@socfortress.co) if you have any question, issue, or idea!

Check out the full SOCfortress video tutorial series on [![YouTube](https://img.shields.io/badge/YouTube-%23FF0000.svg?style=for-the-badge&logo=YouTube&logoColor=white)](https://www.youtube.com/@taylorwalton_socfortress/videos)

## Sponsoring

If you find this project useful and want to support continued development, consider becoming a sponsor:

[![GitHub Sponsors](https://img.shields.io/badge/sponsor-30363D?style=for-the-badge&logo=GitHub-Sponsors&logoColor=#EA4AAA)](https://github.com/sponsors/taylorwalton)

---

## Based On

Talon is a fork of [NanoClaw](https://github.com/qwibitai/nanoclaw), a minimal Claude Agent SDK harness where agents run in isolated Linux containers. The core orchestration engine, container runner, channel system, and IPC layer are NanoClaw. Everything in `groups/copilot/`, `siem/`, `mysql/`, `copilot-mcp/`, `wazuh-mcp/`, `velociraptor-mcp/`, `ollama/`, and `src/channels/http.ts` is purpose-built for the SOCfortress stack.

---

## License

The contents of this repository are available under the [MIT license](LICENSE).
