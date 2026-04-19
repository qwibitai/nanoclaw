---
name: add-security-policy
description: Add configurable security policy engine — tool gating, SSRF protection, readonly mounts, killswitch, and sender trust. Use when the user wants to harden their NanoClaw containers against prompt injection, secret exfiltration, or unauthorized tool use.
---

# Add Security Policy Engine

Adds a declarative security layer that prevents containerized agents from dumping secrets, accessing internal networks, modifying personality/config files, or exfiltrating data — all configurable via a single JSON file.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/security-policy.ts` exists. If it does, skip to Phase 3 (Configure). The code changes are already in place.

### Ask the user

AskUserQuestion: Do you want to use the default security policy (recommended), or do you have a custom security-policy.json ready?

## Phase 2: Apply Code Changes

### Merge the skill branch

```bash
git fetch upstream skill/security-policy
git merge upstream/skill/security-policy || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in:
- `src/security-policy.ts` — core policy engine (loader, trust, killswitch, rules builder)
- `src/security-policy.test.ts` — 67 tests covering regex, trust, tool gating, killswitch
- `config-examples/security-policy.json` — example config with placeholder values
- `src/config.ts` — adds `SECURITY_POLICY_PATH` constant
- `src/router.ts` — extends `formatOutbound()` with markdown image and `<img>` tag stripping
- `src/container-runner.ts` — readonly mount overlays, security rules passed to containers
- `src/index.ts` — policy loading, killswitch checks, sender trust, security rules wiring
- `src/task-scheduler.ts` — scheduled tasks get security rules and killswitch checks
- `container/agent-runner/src/index.ts` — `buildCanUseTool` enforces rules inside containers
- `src/formatting.test.ts` — image stripping tests

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Validate code changes

```bash
npm install
npm run build
npx vitest run src/security-policy.test.ts src/formatting.test.ts
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Configure

### Default policy (no config file needed)

Without a config file, sensible defaults apply automatically:
- Blocks `env`, `printenv`, `set`, `declare -x`, `compgen -v`, `os.environ`, `process.env` patterns in Bash
- Blocks SSRF to localhost, RFC1918, link-local, metadata endpoints, IPv4-mapped IPv6
- Enforces HTTPS-only for WebFetch
- Blocks secret values from appearing in WebFetch URLs
- Blocks writes to `.claude/`, `CLAUDE.md`, `settings.json`, agent-runner source
- Mounts CLAUDE.md, skills, and agent-runner source as readonly in containers
- Strips markdown images and `<img>` tags from agent output (exfiltration vector)

### Custom policy (optional)

Copy the example and edit:

```bash
mkdir -p ~/.config/nanoclaw
cp config-examples/security-policy.json ~/.config/nanoclaw/security-policy.json
```

Edit `~/.config/nanoclaw/security-policy.json`:

- **`trust.owner_ids`** — your channel user IDs (WhatsApp JID, Discord user ID, etc.). Messages from these senders get elevated trust (can write to personality files, use gated tools).
- **`tools.blocked`** — tool names to block entirely (e.g., `Task`, `SendMessage`)
- **`tools.blocked_untrusted`** — tools blocked only for non-owner senders
- **`bash.blocked_env_vars`** — additional env var names to block in Bash commands
- **`webfetch.blocked_url_patterns`** — additional URL patterns to block
- **`write.trust_required_paths`** — paths that require sender trust to write
- **`killswitch`** — file-based emergency stop (write the configured value to disable the agent)

### Build and restart

```bash
npm run build
```

Then restart the service:

```bash
# macOS (launchd)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux (systemd)
systemctl --user restart nanoclaw
```

## Phase 4: Verify

### Test security rules

Send a message from a non-owner sender that tries:
- `run env` or `run printenv` — should be blocked by Bash pattern
- A WebFetch to `http://` (not https) — should be blocked
- Writing to `CLAUDE.md` — should be blocked (readonly mount)

### Test killswitch (optional)

If killswitch is configured:

```bash
echo "enabled" > ~/path/to/killswitch.txt
```

Send a message — the agent should respond with the killswitch message instead of processing.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Agent can't use any tools

1. Check that `securityRules` and `allowedTools` are being passed to the container — look for `securityRules` in logs
2. If using a custom policy, validate the JSON: `node -e "JSON.parse(require('fs').readFileSync('$HOME/.config/nanoclaw/security-policy.json','utf8'))"`
3. Scheduled tasks run as `senderTrusted: false` — ensure `tools.blocked_untrusted` doesn't block tools the scheduler needs

### Killswitch not working

1. Check the file path matches `killswitch.file` in your policy (relative to group folder)
2. File contents must exactly match `killswitch.enabled_value` (after trimming whitespace)
3. Windows-edited files may have BOM — use a plain text editor

### Images still appearing in output

1. Verify `formatOutbound` is being called — check `src/router.ts`
2. Both `![](url)` markdown and `<img>` HTML tags are stripped
3. Channels that render HTML independently of NanoClaw output are not covered
