# How to use NanoClaw with a third-party API endpoint

Use this guide if your organisation runs a custom Anthropic-compatible proxy (e.g. an internal gateway, regional deployment, or cloud provider endpoint) instead of calling the Anthropic API directly.

## Prerequisites

- NanoClaw installed and running (see `/setup`)
- Your proxy's base URL and authentication token

## 1. Add credentials to `.env`

Open the `.env` file in the NanoClaw project root and add the variables your proxy requires. A typical configuration:

```
ANTHROPIC_BASE_URL="https://your-proxy.example.com/path"
ANTHROPIC_AUTH_TOKEN="your-auth-token"
```

If your proxy expects a standard API key header instead, use `ANTHROPIC_API_KEY`:

```
ANTHROPIC_BASE_URL="https://your-proxy.example.com/path"
ANTHROPIC_API_KEY="your-api-key"
```

### Optional: override model IDs

Some proxies use custom model identifiers. Set any of the following to override Claude Code's defaults:

```
ANTHROPIC_DEFAULT_OPUS_MODEL="your-opus-model-id"
ANTHROPIC_DEFAULT_SONNET_MODEL="your-sonnet-model-id"
ANTHROPIC_DEFAULT_HAIKU_MODEL="your-haiku-model-id"
```

## 2. Restart the service

```bash
# macOS
npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
npm run build && systemctl --user restart nanoclaw
```

## 3. Verify

Send a message in your registered WhatsApp chat. Check the logs if there are issues:

```bash
tail -f logs/nanoclaw.log
```

## How it works

NanoClaw passes credentials to container agents via stdin (never written to disk or mounted as files). The Claude Code CLI inside the container reads `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` from its environment and routes all API calls through your proxy. See the [Claude Code third-party integrations documentation](https://docs.anthropic.com/en/docs/claude-code/third-party-integrations) for the full list of supported variables.

## Supported variables

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_BASE_URL` | Custom API endpoint URL |
| `ANTHROPIC_AUTH_TOKEN` | Bearer token for the custom endpoint |
| `ANTHROPIC_API_KEY` | Standard API key (alternative to auth token) |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | Override Opus model ID |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | Override Sonnet model ID |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | Override Haiku model ID |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Pro/Max subscription token |

## Troubleshooting

**"Not logged in - Please run /login"**: The container agent isn't receiving credentials. Check that:
1. Your `.env` has `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY` set (not `export`-prefixed)
2. You rebuilt after any code changes: `npm run build`
3. You restarted the service after editing `.env`

**Authentication errors in logs**: Verify your token is valid by testing outside NanoClaw:
```bash
curl -H "Authorization: Bearer YOUR_TOKEN" https://your-proxy.example.com/v1/models
```

**Model not found errors**: Your proxy may use different model identifiers. Set `ANTHROPIC_DEFAULT_SONNET_MODEL` (and optionally Opus/Haiku) in `.env` to match your proxy's expected model IDs.
