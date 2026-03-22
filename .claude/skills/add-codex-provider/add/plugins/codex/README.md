# nanoclaw-codex-provider

OpenAI Codex provider plugin for [NanoClaw](https://github.com/nicepkg/nanoclaw) — use your ChatGPT Plus/Pro subscription as an LLM backend instead of API credits.

## How It Works

```
ChatGPT Plus/Pro subscription
        │
        ▼
  OAuth PKCE flow (browser login)
        │
        ▼
  codex-oauth (token management)
        │
        ▼
  ┌─────────────────────────────────────┐
  │  Host (host.ts)                     │
  │  • Refreshes OAuth tokens           │
  │  • Provides secrets to container    │
  └─────────────┬───────────────────────┘
                │ stdin JSON (secrets)
                ▼
  ┌─────────────────────────────────────┐
  │  Container (provider-codex.ts)      │
  │  • Calls Codex Responses API        │
  │  • Tool-use loop (bash, files)      │
  │  • Returns text response            │
  └─────────────────────────────────────┘
```

## Quick Start

### 1. Install in NanoClaw

The plugin is included in NanoClaw's `plugins/codex/` directory. No separate installation needed.

### 2. Authenticate

```bash
npx tsx setup/index.ts --step codex-auth
```

This opens a browser for ChatGPT OAuth login. Tokens are stored locally at `data/codex-tokens.json`.

### 3. Configure

Add to your `.env`:

```
AGENT_PROVIDER=codex
```

### 4. Run

```bash
npm run dev
```

Messages will now be routed through the Codex API instead of Claude.

## Architecture

### Files

| File | Runs On | Purpose |
|------|---------|---------|
| `host.ts` | Host | NanoClaw ProviderPlugin — OAuth token management, provides secrets |
| `provider-codex.ts` | Container | Self-contained Codex API client with tool-use loop |
| `types.ts` | Both | Shared type definitions |

### Host Module (`host.ts`)

Implements the `ProviderPlugin` interface:

- **`getSecrets()`** — Returns fresh `CODEX_ACCESS_TOKEN` and `CODEX_ACCOUNT_ID` for each container spawn
- **`isAuthenticated()`** — Checks if OAuth refresh token exists
- **`setup()`** — Runs interactive OAuth PKCE flow via browser

### Container Module (`provider-codex.ts`)

Self-contained Codex API client (zero npm dependencies — Node.js built-ins only):

- Calls `chatgpt.com/backend-api/codex/responses` with SSE streaming
- Implements tool-use loop: bash, read_file, write_file, list_files
- System instructions sent as top-level `instructions` field
- Uses `store: false` for stateless operation
- Includes `reasoning.encrypted_content` for reasoning continuity

### API Details

| Parameter | Value | Notes |
|-----------|-------|-------|
| Endpoint | `chatgpt.com/backend-api/codex/responses` | ChatGPT backend, not OpenAI Platform |
| Auth | `Bearer {access_token}` | OAuth token, not API key |
| Model | `gpt-5.1-codex` | Default; supports gpt-5.1, gpt-5.2-codex, etc. |
| Headers | `chatgpt-account-id`, `OpenAI-Beta: responses=experimental` | Required |
| `store` | `false` | Stateless mode (required) |
| `stream` | `true` | SSE streaming |
| `instructions` | Top-level field | NOT a developer role message |
| `reasoning` | `{ effort: 'medium', summary: 'auto' }` | Configurable |
| `text` | `{ verbosity: 'medium' }` | Controls output length |
| `include` | `['reasoning.encrypted_content']` | For reasoning continuity across turns |

## Supported Models

- **gpt-5.2-codex** — Newest Codex model (supports xhigh reasoning)
- **gpt-5.1-codex** — Standard Codex model (default)
- **gpt-5.1-codex-max** — Max reasoning variant (supports xhigh)
- **gpt-5.1-codex-mini** — Lightweight variant (medium/high only)
- **gpt-5.2** — General purpose (supports none reasoning)
- **gpt-5.1** — General purpose (supports none reasoning)

## Usage Notice

This plugin uses the same OAuth flow as [OpenAI's official Codex CLI](https://github.com/openai/codex). It is intended for **personal development use** with your own ChatGPT Plus/Pro subscription.

For production or multi-user applications, use the [OpenAI Platform API](https://platform.openai.com/).

## Dependencies

- [codex-oauth](../packages/codex-oauth/) — OAuth PKCE authentication and token management
- [NanoClaw](https://github.com/nicepkg/nanoclaw) — Container-based agent framework (peer dependency)

## License

MIT
