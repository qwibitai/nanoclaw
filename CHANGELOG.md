# Changelog

All notable changes to NanoClaw will be documented in this file.

## Pluggable Channel Architecture

**BREAKING CHANGE** — WhatsApp is no longer bundled in core.

NanoClaw now uses a pluggable channel architecture. The core ships with no
channels built in. Each channel (WhatsApp, Telegram, Slack, Discord, Gmail)
is a self-contained skill that registers itself at startup via a factory
pattern. Unconfigured channels are silently skipped.

### Migration for existing WhatsApp users

If you are upgrading from a previous version, open Claude Code in your
NanoClaw directory and run `/add-whatsapp` to re-install WhatsApp as a
pluggable channel. Your existing auth credentials, groups, and scheduled
tasks are preserved — no re-authentication needed.

### What changed

**New: Channel registry (`src/channels/registry.ts`)**
- Factory-based registry where channels self-register at module load
- Barrel file `src/channels/index.ts` triggers registration via imports
- Orchestrator loops through registered channels, connects those with
  credentials, skips the rest
- Exits if no channels are connected

**New: WhatsApp skill (`.claude/skills/add-whatsapp/`)**
- WhatsApp moved from core into its own skill
- Includes channel implementation, auth flow, tests, and manifest
- Applies via the skills-engine like any other channel

**Removed from core:**
- `src/channels/whatsapp.ts` — now lives in the WhatsApp skill
- `src/whatsapp-auth.ts` — now lives in the WhatsApp skill
- `@whiskeysockets/baileys`, `qrcode`, `qrcode-terminal` dependencies
  removed from `package.json`
- `npm run auth` script removed

**Refactored: All channel skills simplified**
- Discord, Slack, Telegram, Gmail skills converted to the pluggable pattern
- Each skill's `modify/` directory reduced from ~3-4 large files (index.ts,
  config.ts, routing.test.ts) to a single small barrel import
  (`src/channels/index.ts`)
- ~4,000 lines of modification files removed across the five skills

**Refactored: Core orchestrator (`src/index.ts`)**
- Replaced hardcoded `WhatsAppChannel` import with dynamic channel loop
- `syncGroupMetadata` generalized to `syncGroups` across all connected
  channels
- Channel-agnostic — no channel-specific code remains in core

**Refactored: Setup skill**
- Setup no longer references WhatsApp directly
- Channel installation is a separate step (run `/add-whatsapp`, etc.)
