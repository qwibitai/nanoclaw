---
name: add-sender-allowlist
description: Add optional sender allowlist enforcement to NanoClaw across any channel where `msg.sender` is populated. Use this for per-chat trigger gating or drop-mode filtering, while preserving default behavior when the config file is missing.
---

# Add Sender Allowlist

This skill adds sender allowlist enforcement backed by a host-only config file:

- `~/.config/nanoclaw/sender-allowlist.json`

# Phase 1: Pre-flight

Check skills state and whether this skill is already applied.

Run:
```bash
cat .nanoclaw/state.yaml 2>/dev/null || echo "NOT_INITIALIZED"
```

- If output is `NOT_INITIALIZED`, initialize in Phase 2.
- If `sender-allowlist` already appears under `applied_skills`, skip code apply and continue to Phase 3.

# Phase 2: Apply Code Changes

Initialize skills system if needed:
```bash
npx tsx scripts/apply-skill.ts --init
```

Apply this skill package:
```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-sender-allowlist
```

If merge conflicts are reported for `src/index.ts`, resolve using:
- `modify/src/index.ts.intent.md`

Validate:
```bash
npm test
npm run build
```

Diff-cleanliness gate — only skill files should be in the PR diff:
```bash
git diff --name-only HEAD ; git ls-files --others --exclude-standard
```
Every path must be under `.claude/skills/add-sender-allowlist/`. If `src/` files appear, revert them:
```bash
git checkout src/index.ts && rm -f src/sender-allowlist.ts src/sender-allowlist.test.ts && rm -rf .nanoclaw
```

# Phase 3: Setup — Create the Config

Create the host config directory:
```bash
mkdir -p ~/.config/nanoclaw
```

Ask the user using AskUserQuestion:
1. Which groups do you want to restrict? (list group names)
2. Who should be allowed to trigger the agent? (list names or phone numbers)
3. Trigger mode or drop mode?

Then resolve exact `chat_jid` and `sender` strings from NanoClaw's stored messages and show candidates back to the user for confirmation (especially when names are ambiguous). Do NOT ask the user to provide raw JID strings.

If multiple sender strings match a person, ask a short follow-up and let the user pick the exact sender identity.

Create `~/.config/nanoclaw/sender-allowlist.json` using the resolved JIDs.

Trigger-mode example:

```json
{
  "default": {
    "allow": "*",
    "mode": "trigger"
  },
  "chats": {
    "group-alpha": {
      "allow": ["sender-a", "sender-b"],
      "mode": "trigger"
    }
  },
  "logDenied": true,
  "failMode": "open"
}
```

Drop-mode example:

```json
{
  "default": {
    "allow": "*",
    "mode": "trigger"
  },
  "chats": {
    "group-alpha": {
      "allow": ["sender-a"],
      "mode": "drop"
    }
  },
  "logDenied": true,
  "failMode": "open"
}
```

Config fields:
- `allow`: `"*"` (allow all), `[]` (deny all), or `["sender1", "sender2"]` (exact match allowlist)
- `deny`: optional `["sender1", "sender2"]` — block these senders even if `allow` is `"*"`. Takes priority over `allow`.
- `mode`: `"trigger"` (store all, gate activation) or `"drop"` (don't store denied senders)
- `logDenied`: `true` logs a debug/info line when a sender is denied
- `failMode`: `"open"` (allow all when invalid/missing) or `"closed"` (deny all when invalid)

# Phase 4: Verify

Trigger mode:
- Send a trigger message from a denied sender.
- Confirm no activation.
- Send the same trigger from an allowed sender.
- Confirm activation.

Drop mode:
- Send one message from a denied sender.
- Confirm it is not stored by reviewing the agent context on the next allowed trigger — the denied sender's message should not appear.
- Trigger from an allowed sender and confirm only allowed/history messages influence context.

Optional log check:
```bash
tail -f logs/nanoclaw.log | grep sender-allowlist
```

# Phase 5: Removal

Preferred:
```bash
npx tsx scripts/uninstall-skill.ts sender-allowlist
npm test
npm run build
```

If uninstall tooling is unavailable, manually:
- delete `src/sender-allowlist.ts`
- delete `src/sender-allowlist.test.ts`
- revert `src/index.ts`
- remove `sender-allowlist` from `.nanoclaw/state.yaml` `applied_skills`

Optional config cleanup:
```bash
rm ~/.config/nanoclaw/sender-allowlist.json
```
