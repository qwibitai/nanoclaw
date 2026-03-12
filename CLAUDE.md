# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process that connects to WhatsApp, routes messages to Claude Agent SDK running in Docker containers (Linux) or Apple Container (macOS). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/whatsapp.ts` | WhatsApp connection, auth, send/receive |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/agent-browser/` | Browser automation skill |
| `container/skills/send-email/` | Email outreach skill |
| `container/skills/social-posting/` | Social media posting skill (X, Facebook, LinkedIn) |
| `container/skills/crm-query/` | CRM query/import skill |
| `container/skills/outreach-workflow/` | End-to-end outreach workflow |
| `container/skills/content-creation/` | Brand voice and content guidelines |
| `container/skills/google-sheets/` | Google Sheets read/write/append |
| `container/skills/google-calendar/` | Google Calendar events + availability |
| `container/skills/vending-inventory/` | Vending machine sales + inventory automation |
| `container/skills/inventory-reconcile/` | Cross-source inventory reconciliation + blacklist engine |
| `tools/inventory/reconcile.ts` | Unified reconciliation CLI (IDDI + Sheets → reorder/blacklist decisions) |
| `container/skills/gmail/` | Gmail read/search/send/reply via API |
| `container/skills/google-drive/` | Google Drive file access |
| `container/skills/instantly/` | Instantly.ai cold email campaigns (push leads, sync replies, analytics) |
| `container/skills/lead-finder/` | Lead generation (Maps, scraping, scoring) |
| `container/skills/viral-content/` | Viral content engine (trend scraping, pattern learning, remixing) |
| `tools/email/send-email.ts` | SMTP email sender (supports HTML templates, attachments, inline images) |
| `tools/email/templates/` | HTML email templates (coffee-intro, vending-intro, ice-machine-intro, case-study, follow-up) |
| `tools/social/post-tweet.ts` | X/Twitter API poster |
| `tools/social/post-facebook.ts` | Facebook Graph API poster |
| `tools/social/read-facebook-insights.ts` | Facebook post engagement metrics reader |
| `tools/social/post-linkedin.ts` | LinkedIn API poster |
| `tools/social/linkedin-connect.ts` | LinkedIn connection requests and messaging |
| `tools/social/trend-scraper.ts` | Trend monitoring and viral pattern analysis |
| `groups/main/assets/` | Product photos, PDFs, video thumbnails for email campaigns |
| `groups/main/viral-patterns.md` | Evolving viral content patterns knowledge file |
| `tools/instantly/instantly.ts` | Instantly.ai API (campaigns, leads, replies, warmup) |
| `tools/crm/import-apollo.ts` | Apollo.io CSV lead importer |
| `tools/crm/query-contacts.ts` | CRM contact query utility |
| `tools/crm/lead-score.ts` | Lead scoring engine (0-100) |
| `tools/crm/scoring-config.json` | Scoring weights config |
| `tools/drive/drive.ts` | Google Drive list/search/download |
| `tools/leads/google-maps.ts` | Google Maps Places API lead finder |
| `tools/leads/website-scraper.ts` | Website email/phone scraper |
| `tools/sheets/sheets.ts` | Google Sheets API tool |
| `tools/calendar/calendar.ts` | Google Calendar API tool |
| `tools/gmail/gmail.ts` | Gmail API tool (domain-wide delegation) |
| `deploy/setup-vps.sh` | VPS hardening and installation script |
| `deploy/nanoclaw.service` | systemd service file |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management (macOS):
```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
```

Service management (Linux / Contabo VPS):
```bash
sudo systemctl start nanoclaw
sudo systemctl stop nanoclaw
sudo journalctl -u nanoclaw -f  # View logs
```

## Container Build Cache

Apple Container's buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild:

```bash
container builder stop && container builder rm && container builder start
./container/build.sh
```

Always verify after rebuild: `container run -i --rm --entrypoint wc nanoclaw-agent:latest -l /app/src/index.ts`
