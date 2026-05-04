# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/` | Skills loaded inside agent containers (browser, status, formatting) |

## Secrets / Credentials / Proxy (OneCLI)

API keys, secret keys, OAuth tokens, and auth credentials are managed by the OneCLI gateway — which handles secret injection into containers at request time, so no keys or tokens are ever passed to containers directly. Run `onecli --help`.

## Skills

Four types of skills exist in NanoClaw. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and guidelines.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-slack`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/init-onecli` | Install OneCLI Agent Vault and migrate `.env` credentials to it |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, SKILL.md format rules, PR requirements, and the pre-submission checklist (searching for existing PRs/issues, testing, description format).

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## WhatsApp Cloud API — Webhook Setup

NanoClaw now uses the Meta WhatsApp Business Cloud API instead of Baileys. Required env vars:

```
WHATSAPP_PHONE_NUMBER_ID=   # from Meta Developer Console → WhatsApp → API Setup
WHATSAPP_ACCESS_TOKEN=       # permanent system user token from Meta
WHATSAPP_VERIFY_TOKEN=       # any string you pick — set the same value in Meta webhook config
WHATSAPP_WEBHOOK_PORT=3003   # port the webhook server listens on (default: 3003)
```

The webhook server listens at `POST /webhook/whatsapp` on port 3003. Meta must be able to reach it over HTTPS. For WSL + Docker:

1. Expose port 3003 from the container: add `-p 3003:3003` to your `docker run` command (or the equivalent in your compose/deployment config).
2. In WSL, the Docker port is accessible on the Windows host at `localhost:3003`.
3. For Meta to reach the webhook, you need a public HTTPS URL. Use **ngrok** or **cloudflared**:
   ```bash
   # ngrok (easiest for dev):
   ngrok http 3003
   # Use the generated https://xxxx.ngrok-free.app URL as your Meta webhook URL

   # cloudflared (free, no account needed for dev):
   cloudflared tunnel --url http://localhost:3003
   ```
4. In Meta Developer Console → WhatsApp → Configuration → Webhooks:
   - Webhook URL: `https://<your-tunnel>/webhook/whatsapp`
   - Verify token: value of `WHATSAPP_VERIFY_TOKEN`
   - Subscribe to: `messages`
5. In AKS, expose port 3003 via a Service/Ingress and point Meta at the public URL.

Validate credentials: `npm run auth` — calls the Graph API and prints phone number details.

## Pending Work

- **Register Telegram chat on fresh AKS deploy** — `groupCount: 0` on first start. No sqlite3 in container — use Node:
  ```
  kubectl exec -n nanoclaw deployment/nanoclaw -c nanoclaw -- node -e "
  const Database = require('better-sqlite3');
  const db = new Database('/app/store/messages.db');
  db.prepare(\"INSERT OR REPLACE INTO registered_groups (jid,name,folder,trigger_pattern,added_at,container_config,requires_trigger,is_main) VALUES (?,?,?,?,?,?,?,?)\").run('tg:7966417139','Jordan','telegram_main','@Tim',new Date().toISOString(),null,0,1);
  db.close(); console.log('done');
  "
  ```

- **authMode oauth** — `ONECLI_URL` in configmap is commented out but credential proxy still shows `authMode: oauth`. Investigate `detectAuthMode()` in `src/credential-proxy.ts` — may need to explicitly set `CREDENTIAL_PROXY_AUTH_MODE=api-key` in the configmap.

## Troubleshooting

**WhatsApp channel disabled at startup:** Set `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, and `WHATSAPP_VERIFY_TOKEN` in `.env`. Run `npm run auth` to validate.

**Meta webhook verification failing:** Confirm the verify token in Meta Developer Console matches `WHATSAPP_VERIFY_TOKEN` in `.env`, and that port 3003 is reachable from the internet (see Webhook Setup above).

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
