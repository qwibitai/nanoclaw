# Sprint 1: Extract Channels + Quick Wins

**Package:** cambot-agent
**Duration:** ~1-2 weeks
**Sprint Goal:** Remove channel code from cambot-agent and depend on cambot-channels instead.

---

## Stories

### 0.1 — Replace internal channels with cambot-channels dependency
- [ ] Add cambot-channels as a dependency
- [ ] Remove src/channels/ directory entirely (WhatsApp, CLI, registry moved to cambot-channels)
- [ ] Import `loadChannels()` and `Channel` type from cambot-channels
- [ ] Update index.ts to use imported channel loader
- [ ] Remove channel-related types from types.ts (now in cambot-channels)
- [ ] Verify all existing tests pass with external channels
- [ ] Verify WhatsApp, CLI, Discord, Telegram all work via cambot-channels

---

## Coordinated with:
- cambot-channels Sprint 1 (extraction + Discord/Telegram merge)
- cambot-core-ui Sprint 1 (trust page)

## Definition of Done
- Zero channel implementation code in cambot-agent
- cambot-agent imports Channel interface and registry from cambot-channels
- All channels work identically after extraction
- Adding a new channel in cambot-channels requires zero changes here
