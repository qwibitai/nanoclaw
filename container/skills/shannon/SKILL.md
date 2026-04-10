---
name: shannon
description: "Autonomous AI pentest framework for web apps and APIs. Use for: pentest, penetration test, security scan, vulnerability audit, hack this, security review, AppSec, OWASP. Runs via ./shannon start URL=url REPO=name in ~/d/git/shannon/. NOT for routine code review — use argus or webcopilot for lightweight checks."
---

# shannon-skill

Wrapper skill for running [Shannon](https://github.com/keygraph/shannon), an autonomous AI pentesting framework. Located at `~/d/git/shannon/`.

## Prerequisites

- **Docker** must be running
- **ANTHROPIC_API_KEY** set in `~/d/git/shannon/.env`
- Target repo cloned/symlinked into `~/d/git/shannon/repos/NAME`

## Quick Start

```bash
cd ~/d/git/shannon

# Clone/symlink target repo first
ln -s /path/to/target-repo ./repos/my-target

# Run a pentest
./shannon start URL=https://target.example.com REPO=my-target

# Run with named workspace (for resume)
./shannon start URL=https://target.example.com REPO=my-target WORKSPACE=my-audit

# List all workspaces
./shannon workspaces

# Tail live logs
./shannon logs

# Stop
./shannon stop
```

## Architecture

Five-phase pipeline:

| Phase | Agent | What It Does |
|-------|-------|-------------|
| 1 | Pre-Recon | Static code analysis — maps attack surface from source |
| 2 | Recon | Browser automation — correlates live app with code findings |
| 3 | Vuln Analysis (x5 parallel) | Injection, XSS, SSRF, AUTH, AUTHZ agents |
| 4 | Exploitation (x5 parallel) | POC exploits via Playwright — proof or it didn't happen |
| 5 | Reporting | Executive pentest report with remediation steps |

## Workspace and Resume

```bash
# Named workspace (auto-resumes if already exists)
./shannon start URL=... REPO=... WORKSPACE=audit-2024-01

# Auto-named workspace
./shannon start URL=... REPO=... WORKSPACE=auto

# List workspaces
./shannon workspaces
```

Resume picks up from last checkpoint — completed agents are skipped.

## Output

- Reports saved to `audit-logs/WORKSPACE/`
- Deliverables saved to `deliverables/` in the target repo
- Temporal Web UI at `http://localhost:8233`

## Common Options

```bash
CONFIG=./configs/my-config.yaml    # YAML config (auth, MFA/TOTP settings)
OUTPUT=./custom-output/            # Custom output dir
WORKSPACE=my-audit               # Named workspace
PIPELINE_TESTING=true             # Minimal prompts, 10s retries (dev)
REBUILD=true                       # Force Docker image rebuild
ROUTER=true                        # Enable claude-code-router multi-model routing
CLEAN=true                         # Full cleanup on stop (including volumes)
```

## Config File

For authenticated testing (login flows, MFA/TOTP), create a YAML config in `configs/`:

```yaml
auth:
  type: form | sso | api | basic
  credentials:
    username: user@example.com
    password: secret
```

See `configs/` directory for full schema with SSO, OAuth, and TOTP support.

## When to Use This vs Other Tools

| Tool | Scope | Use Case |
|------|-------|----------|
| **shannon** | Full pentest, autonomous, 5-phase | Production security assessment, AppSec review |
| **argus** | Lightweight reconnaissance | Quick surface scan, one-off checks |
| **webcopilot** | Automated vuln scanning | Light scan, known CVE patterns |
| **manual code review** | Focused security review | Auth, RLS, specific feature |

Shannon is heavyweight — runs 10+ parallel agents, Docker containers, Temporal workflow. Use for full-scope pentests, not quick checks.

## Tips

- Always symlink existing repos rather than cloning fresh to save space
- The `./shannon logs` command tails worker output in real time
- If exploitation phase finds nothing exploitable, those agents exit early (normal)
- Pipeline is crash-safe — Temporal preserves workflow state across restarts
