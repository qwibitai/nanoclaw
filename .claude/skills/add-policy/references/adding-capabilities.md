# Adding Capabilities and Roles

`~/.config/nanoclaw/policy.json` and `~/.config/nanoclaw/roles.json` are the live configuration for the policy layer. Changes to either file take effect on the next service restart — the configs are loaded once at startup.

## Adding a New Capability

Open `~/.config/nanoclaw/policy.json` and add a new key under `capabilities`:

```json
{
  "capabilities": {
    "scheduler.crossGroup": ["admin"],
    "register_group":       ["admin"],
    "refresh_groups":       ["admin"],
    "system.remoteControl": ["admin"],
    "gdrive.write":         ["admin", "member"]
  },
  "unknown_sender": {"roles": ["member"]}
}
```

Capability value rules:

| Value | Meaning |
|-------|---------|
| `["admin"]` | Only admin role allowed |
| `["admin", "member"]` | Both admin and member allowed |
| `"*"` | All roles allowed (public) |
| `[]` | Denied for all roles |

The capability key is the string passed to `checkCapability(canonical_id, capability)` in source code. Keep names namespaced with a dot (e.g. `gdrive.write`, `scheduler.crossGroup`) to avoid collisions as the capability set grows.

## Adding a New Role

Open `~/.config/nanoclaw/roles.json` and add a key under `roles`:

```json
{
  "roles": {
    "admin":  {"description": "Full control — cross-group scheduling, group registration, remote control"},
    "member": {"description": "Default employee role — own-group scheduling, assistant use"},
    "ops":    {"description": "Operations team — refresh and registration access, no remote control"}
  }
}
```

Then assign the new role to people in `~/.config/nanoclaw/people.json`:

```json
{
  "canonical_id": "alice@almalabs.ai",
  "display_name": "Alice Chen",
  "roles": ["ops"],
  "channels": {
    "slack": "U04ABCD1234"
  }
}
```

Finally, wire the new role into any capabilities it should cover in `policy.json`:

```json
"refresh_groups": ["admin", "ops"],
"register_group": ["admin", "ops"]
```

## Applying Changes

Restart the service after editing either config file:

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

Verify the new capability or role is active by checking the log for the policy load line:

```bash
grep "policy" logs/nanoclaw.log | tail -5
```

Then test by triggering the capability as a user with the new role and confirming a `decision = 'allow'` row appears in `audit_log`:

```bash
sqlite3 store/messages.db "SELECT ts, canonical_id, capability, decision FROM audit_log ORDER BY ts DESC LIMIT 10;"
```
