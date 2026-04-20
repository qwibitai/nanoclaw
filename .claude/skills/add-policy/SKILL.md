---
name: add-policy
description: This skill should be used when the user wants to "add role-based permissions", "configure capability policies", "set up admin and member roles", "add policy layer", "install the policy module", "control who can schedule cross-group tasks", or "run add-policy". Installs the NanoClaw role-based capability layer: seeds roles.json and policy.json, wires loadPolicyConfig into src/index.ts and src/ipc.ts, and verifies admin/member authorization checks.
---

# Add Role-Based Capability Policy

The policy layer controls which roles can perform privileged operations — cross-group scheduling, group registration, remote control, and group refresh. It reads from two host-external configs, `roles.json` (role definitions) and `policy.json` (capability → role mappings), and runs alongside the identity layer to produce `checkCapability(canonical_id, capability) → bool`.

## Prerequisites

- `src/policy/` module already merged — it is part of this branch and is present if the skill is being run from the correct branch. Verify:

  ```bash
  ls src/policy/policy.ts 2>/dev/null && echo "policy module present" || echo "MISSING — apply skill/add-policy branch first"
  ```

- Identity layer (`skill/add-identity`) must be installed first. The policy layer reads `canonical_id` and `roles` from messages resolved by the identity layer. Without identity resolution, all senders fall through to the `unknown_sender` policy.

- `~/.config/nanoclaw/people.json` must be seeded with at least one admin. If this has not been done yet, run `/add-identity` first.

## Step 1 — Seed roles.json

Check whether the config file exists:

```bash
ls ~/.config/nanoclaw/roles.json 2>/dev/null && echo "exists" || echo "missing"
```

If missing, create it:

```bash
cat > ~/.config/nanoclaw/roles.json << 'EOF'
{
  "roles": {
    "admin":  {"description": "Full control — cross-group scheduling, group registration, remote control"},
    "member": {"description": "Default employee role — own-group scheduling, assistant use"}
  }
}
EOF
```

Add new roles at any time by adding keys to the `roles` object. Changes take effect on the next service restart.

## Step 2 — Seed policy.json

Check whether the config file exists:

```bash
ls ~/.config/nanoclaw/policy.json 2>/dev/null && echo "exists" || echo "missing"
```

If missing, create it:

```bash
cat > ~/.config/nanoclaw/policy.json << 'EOF'
{
  "capabilities": {
    "scheduler.crossGroup": ["admin"],
    "register_group":       ["admin"],
    "refresh_groups":       ["admin"],
    "system.remoteControl": ["admin"]
  },
  "unknown_sender": {"roles": ["member"]}
}
EOF
```

Capability values follow these rules:

- An array of role names (e.g. `["admin"]`) means only those roles can use the capability.
- `"*"` means all roles are allowed (public access).
- `[]` (empty array) means the capability is denied for all roles.

The `unknown_sender` block assigns a default role set to any sender whose `canonical_id` could not be resolved by the identity layer.

## Step 3 — Verify people.json has admin role

Confirm at least one person in `~/.config/nanoclaw/people.json` carries `"roles": ["admin"]`. The policy layer reads roles from the identity-resolved `msg.roles` field — roles must be assigned in `people.json`, not in `policy.json`. `policy.json` only declares which roles are required; `people.json` declares which people hold those roles.

```bash
node -e "
const p = require(process.env.HOME + '/.config/nanoclaw/people.json');
const admins = p.people.filter(x => x.roles.includes('admin'));
console.log('Admin count:', admins.length);
admins.forEach(a => console.log(' -', a.canonical_id));
"
```

At least one admin must appear before continuing.

## Step 4 — Build and restart

```bash
npm run build
```

Start the service after a successful build:

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

Wait a few seconds, then confirm startup completed without errors:

```bash
tail -20 logs/nanoclaw.log
```

Look for any `policy` or `policy.json` error lines. A clean start logs the number of capabilities loaded.

## Step 5 — Verify capability enforcement

Test with a member-role user — attempt a cross-group operation (e.g., scheduling a task for a different group). The request should be rejected with a log entry:

```bash
grep "Unauthorized\|callerCanDo\|Remote control rejected" logs/nanoclaw.log | tail -20
```

Check the `audit_log` table for deny decisions:

```bash
sqlite3 store/messages.db "SELECT ts, canonical_id, capability, decision FROM audit_log ORDER BY ts DESC LIMIT 10;"
```

A row with `decision = 'deny'` confirms the policy layer is active and blocking unauthorized access.

## Troubleshooting

**All operations still allowed for member:** Confirm the `src/policy/` module compiled — look for `dist/policy/policy.js`. Verify `loadPolicyConfig` resolves the file at `~/.config/nanoclaw/policy.json`. Check that `policy.json` is valid JSON with `node -e "require(process.env.HOME+'/.config/nanoclaw/policy.json')"`.

**Admin is denied:** Verify the person's entry in `people.json` carries `"roles": ["admin"]`. The policy layer only works when the identity layer has resolved the sender — a NULL `canonical_id` means the sender falls through to `unknown_sender` treatment, which defaults to `member`.

**`callerId`/`callerRoles` flow:** Host-level enforcement (remote-control via `handleRemoteControl`) works immediately after this step. IPC-level enforcement requires the container to pass `callerId` and `callerRoles` in IPC task data — this container-side change is tracked in `docs/UPSTREAM-PRS.md` (entries 5 and 6).

**Note on full IPC enforcement:** The `callerId` in IPC data originates from the `NANOCLAW_CALLER_ID` env var set by `src/container-runner.ts`. The container's MCP server (`container/agent-runner/src/ipc-mcp-stdio.ts`) needs to read this env var and include `callerId` and `callerRoles` in every IPC task it writes. This container-side change is tracked in `docs/UPSTREAM-PRS.md`.

## References

See `references/adding-capabilities.md` for how to add new capabilities and roles after initial setup.
