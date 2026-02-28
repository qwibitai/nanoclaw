# MCP Tools Reference

All tools available to agents inside containers. Tools are registered as MCP tools via the `sovereign` MCP server.

## Messaging

### send_message

Send a message to the user or group immediately.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `text` | string | yes | The message text to send |
| `sender` | string | no | Role/identity name (e.g. "Researcher") |

## Scheduling

### schedule_task

Schedule a recurring or one-time task.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | yes | What the agent should do |
| `schedule_type` | `cron` \| `interval` \| `once` | yes | Schedule type |
| `schedule_value` | string | yes | Cron expression, milliseconds, or local timestamp |
| `context_mode` | `group` \| `isolated` | no | Whether to include chat history (default: `group`) |
| `model` | string | no | Model override (e.g. `minimax/minimax-m2.5`) |
| `target_group_jid` | string | no | Target group JID (main group only) |

### list_tasks

List all scheduled tasks. Main group sees all; others see their own.

### pause_task

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task_id` | string | yes | Task ID to pause |

### resume_task

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task_id` | string | yes | Task ID to resume |

### cancel_task

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task_id` | string | yes | Task ID to cancel |

## Groups

### register_group

Register a new group for the agent to respond in. Main group only.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `jid` | string | yes | Group JID |
| `name` | string | yes | Display name |
| `folder` | string | yes | Folder name (lowercase, hyphens) |
| `trigger` | string | yes | Trigger word (e.g. "@Andy") |

## Memory

### recall

Search workspace files using BM25 relevance ranking.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Search keywords |
| `folder` | `all` \| `knowledge` \| `daily` \| `projects` \| `areas` \| `conversations` \| `resources` | no | Folder to search (default: `all`) |
| `max_results` | number | no | Max results (default: 20) |
| `mode` | `layered` \| `full` | no | Compact summaries or full snippets (default: `layered`) |

### recall_detail

Fetch full content of a specific workspace file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file` | string | yes | Relative file path (e.g. `knowledge/patterns.md`) |

### remember

Write to long-term memory (workspace files).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file` | string | yes | Relative path within workspace |
| `content` | string | yes | Text to write |
| `mode` | `append` \| `overwrite` | no | Write mode (default: `append`) |

## SignalWire (Phone)

### send_sms

Send an SMS text message.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `to` | string | yes | Phone number (E.164 format) |
| `body` | string | yes | Message text (max 1600 chars) |

Rate limit: 10/hour.

### check_messages

Check recent SMS messages.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `direction` | `inbound` \| `outbound` \| `all` | no | Filter direction (default: `all`) |
| `limit` | number | no | Max messages (default: 10, max: 50) |

### make_call

Make a phone call with text-to-speech.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `to` | string | yes | Phone number (E.164 format) |
| `message` | string | yes | TTS message |
| `voice` | `man` \| `woman` \| `alice` | no | Voice (default: `man`) |

Rate limit: 5/hour.

### check_calls

Check recent call logs.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | number | no | Max records (default: 10, max: 50) |

## Payments

### x402_fetch

Make an HTTP request with automatic x402 payment support.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | yes | URL to fetch |
| `method` | string | no | HTTP method (default: `GET`) |
| `headers` | object | no | HTTP headers |
| `body` | string | no | Request body |
| `max_price_usd` | number | no | Max USDC to pay (default: $1) |

Daily spend cap: $10.

## Delegation

### delegate_task

Spawn a worker agent for a subtask.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | yes | Task description (include all context) |
| `model` | string | no | Model override for worker |
| `timeout_seconds` | number | no | Max wait time (default: 300, max: 600) |

## Elicitation

### ask_structured

Ask the user a question with predefined options.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `question` | string | yes | The question |
| `options` | string[] | yes | Options to present (2-10) |
| `allow_freetext` | boolean | no | Allow custom response (default: false) |
| `timeout_seconds` | number | no | Wait time (default: 300) |

## Self-Knowledge

### self_knowledge

Explain agent capabilities from `knowledge/capabilities.json`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `section` | string | no | Section name for details (omit for overview) |

## Relay

### send_relay

Send a message to another agent via the host relay.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `to` | string | yes | Target agent's group folder name |
| `content` | string | yes | Message body |
| `reply_to` | string | no | ID of message being replied to |

### check_relay

Check relay inbox for messages from other agents. Read-once: messages are removed after reading.
