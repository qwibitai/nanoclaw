# Adding People to people.json

`~/.config/nanoclaw/people.json` is the source of truth for cross-channel identity. Each entry maps a person's `@almalabs.ai` email to their channel-specific user IDs. Changes take effect on the next service restart — the config is loaded once at startup.

## Finding a Slack User ID

1. Open Slack and navigate to the person's profile (click their name or avatar anywhere in Slack).
2. Click the three-dot menu (⋯) in the top-right of the profile popover.
3. Select **Copy member ID**. The ID starts with `U` followed by uppercase letters and digits (e.g. `U04ABCD1234`).

Alternatively, copy the profile URL from a browser — the ID is the path segment after `/team/`.

## Finding a Telegram User ID

1. Open Telegram (mobile or desktop).
2. Search for `@userinfobot` and start a conversation.
3. Send any message (e.g. `/start`). The bot replies with your numeric user ID (e.g. `123456789`).

To find someone else's Telegram ID, forward one of their messages to `@userinfobot` — it will return the sender's ID.

## JSON Structure for Each Entry

```json
{
  "canonical_id": "alice@almalabs.ai",
  "display_name": "Alice Chen",
  "roles": ["admin"],
  "channels": {
    "slack": "U04ABCD1234",
    "tg": "123456789"
  }
}
```

Fields:

| Field | Required | Description |
|-------|----------|-------------|
| `canonical_id` | yes | `@almalabs.ai` email — used as the stable identifier across all channels |
| `display_name` | yes | Human-readable name shown in logs and agent context |
| `roles` | yes | Array of `"admin"` or `"member"` — controls which tools and commands the person can access |
| `channels.slack` | no | Slack member ID (`U...`). Omit if the person does not use Slack. |
| `channels.tg` | no | Telegram numeric user ID. Omit if the person does not use Telegram. |

## Adding a New Employee

Open `~/.config/nanoclaw/people.json` and append a new object to the `people` array:

```json
{
  "canonical_id": "bob@almalabs.ai",
  "display_name": "Bob Smith",
  "roles": ["member"],
  "channels": {
    "slack": "U05WXYZ9876"
  }
}
```

Restart the service to load the change:

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

## Multi-Role Example

Assign multiple roles when a person fills more than one function:

```json
{
  "canonical_id": "carol@almalabs.ai",
  "display_name": "Carol Liu",
  "roles": ["admin", "eng"],
  "channels": {
    "slack": "U06LMNOP4567",
    "tg": "987654321"
  }
}
```

The `roles` array is passed to the agent container as `NANOCLAW_CALLER_ROLES` (comma-separated). MCP tools can inspect this value to gate privileged operations.

## default_role

The top-level `"default_role"` field applies to any sender whose channel ID does not match any entry in `people`. Set it to `"member"` to allow unrecognized senders a basic level of access, or remove all permissions from unknown senders by adding authorization checks in your group's `CLAUDE.md`.
