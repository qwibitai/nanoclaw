# Custom API Endpoint Setup

NanoClaw can be configured to use custom API endpoints instead of Anthropic's default API. This is useful for:

- Alternative API providers (e.g., z.ai, OpenRouter)
- Self-hosted model proxies
- Custom model configurations

## Configuration

### 1. Set Environment Variables

Edit your `.env` file:

```bash
# Required: Your custom API endpoint
ANTHROPIC_BASE_URL="https://api.example.com/api/anthropic"

# Required: API key for authentication
ANTHROPIC_API_KEY="your-api-key-here"

# Optional: Model configuration
ANTHROPIC_MODEL="your-model-name"
ANTHROPIC_DEFAULT_OPUS_MODEL="your-model-name"
ANTHROPIC_DEFAULT_SONNET_MODEL="your-model-name"
ANTHROPIC_DEFAULT_HAIKU_MODEL="your-fast-model"
ANTHROPIC_SMALL_FAST_MODEL="your-fast-model"
```

### 2. Sync Environment Files

NanoClaw uses multiple environment files. Sync them after changes:

```bash
cp .env data/env/env
```

### 3. Restart Service

```bash
# Linux
systemctl --user restart nanoclaw

# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Example: z.ai Configuration

```bash
ANTHROPIC_BASE_URL="https://api.z.ai/api/anthropic"
ANTHROPIC_API_KEY="your-zai-token"
ANTHROPIC_MODEL="glm-5"
ANTHROPIC_DEFAULT_OPUS_MODEL="glm-5"
ANTHROPIC_DEFAULT_SONNET_MODEL="glm-5"
ANTHROPIC_DEFAULT_HAIKU_MODEL="glm-4.7-flash"
ANTHROPIC_SMALL_FAST_MODEL="glm-4.7-flash"
```

## How It Works

1. **Credential Proxy**: NanoClaw runs a local proxy that containers connect to instead of the external API directly
2. **Path Handling**: The proxy correctly handles base URLs with paths (e.g., `/api/anthropic`)
3. **Model Config**: Model environment variables are passed to containers via `settings.json`

## Troubleshooting

### Container can't reach API

Check firewall rules allow Docker containers to reach the host:

```bash
# Allow Docker traffic to host
sudo iptables -I INPUT -i docker0 -j ACCEPT
```

### 404 errors from API

Verify your `ANTHROPIC_BASE_URL` is correct. Test directly:

```bash
curl -s "${ANTHROPIC_BASE_URL}/v1/messages" \
  -H "x-api-key: ${ANTHROPIC_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"model":"your-model","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}'
```

### Model not found errors

Ensure model names in your `.env` match what your API provider supports.

## Port Requirements

The credential proxy runs on port 3001. Ensure:

- Port 3001 is available on the host
- Docker containers can reach the host's bridge network IP (typically `172.17.0.1`)
