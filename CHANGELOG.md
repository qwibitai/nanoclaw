# Changelog

All notable changes to NanoClaw will be documented in this file.

## BREAKING CHANGE — Pluggable Channel Architecture

NanoClaw now uses a pluggable channel architecture. WhatsApp is no longer
bundled in core — it is a skill that must be explicitly applied.

**What changed:**

- Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are now pluggable
  skills that self-register at startup via `registerChannel()`.
- The `ENABLED_CHANNELS` environment variable has been removed. Channels
  auto-enable when their credentials are present (e.g., WhatsApp activates
  when `store/auth/creds.json` exists; Telegram activates when
  `TELEGRAM_BOT_TOKEN` is set in `.env`).
- The `setup/channels` step has been removed from the setup wizard.

**Migration for existing WhatsApp users:**

If you are upgrading from a previous version and use WhatsApp, you must
install the WhatsApp skill:

```bash
npx tsx skills-engine/apply.ts .claude/skills/add-whatsapp
npm run build
```

Then restart the service. Your existing auth credentials and registered
groups are preserved — no re-authentication needed.
