---
name: configure-model
description: Interactive configuration guide for switching between Anthropic Claude and alternative model providers (Zhipu GLM, custom proxies). Provides step-by-step guidance, provider templates, and model name configuration. UX enhancement for the built-in multi-provider support added in upstream PR #592. Triggers on "configure model", "change model", "switch provider", "use glm", "use claude", "model config".
---

# Model Provider Configuration Guide

> **Note:** NanoClaw (via upstream PR #592) already supports third-party model providers through `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` environment variables. This skill provides an **interactive configuration guide** with provider-specific templates, step-by-step instructions, and model name configuration.

**Principle:** Make changes directly. Only pause for user input when a choice or secret is required.

## Quick Summary

NanoClaw supports two configuration channels:

| Channel | Purpose | Location |
|---------|---------|----------|
| **Environment variables** | API endpoint URL, auth tokens | `.env` file (project root) |
| **Model overrides** | Model names (Haiku/Sonnet/Opus) | `settings.json` template in `src/container-runner.ts` |

This skill guides you through:
1. **Selecting a provider** (Anthropic, Zhipu GLM, or custom)
2. **Configuring authentication** (with provider templates)
3. **Setting model names** (with tested configurations)
4. **Applying to existing groups** (optional)

## Provider Templates

### Option 1: Anthropic Claude (Default)

**Best for:** Production use, full Claude Code feature support

**Configuration:**
```bash
# .env
ANTHROPIC_API_KEY=sk-ant-xxx  # or CLAUDE_CODE_OAUTH_TOKEN
```

**Model names:** Leave unset (uses Claude Code built-in defaults)

---

### Option 2: Zhipu GLM (智谱)

**Best for:** Cost-effective Chinese language model

**Tested on:** Production deployment (AWS: ubuntu@52.53.89.108)

**Configuration:**
```bash
# .env
ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic
ANTHROPIC_AUTH_TOKEN=<your-zhipu-token>

# Model overrides (all tiers use same model)
ANTHROPIC_DEFAULT_HAIKU_MODEL=glm-5
ANTHROPIC_DEFAULT_SONNET_MODEL=glm-5
ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5
```

**Getting a token:** https://open.bigmodel.cn/usercenter/apikeys

---

### Option 3: Other Anthropic-Compatible Providers

**Supported:** Together AI, Fireworks, custom proxies, local models via Ollama

**Configuration template:**
```bash
# .env
ANTHROPIC_BASE_URL=<your-provider-endpoint>
ANTHROPIC_AUTH_TOKEN=<your-token>

# Optional: Model name overrides
ANTHROPIC_DEFAULT_HAIKU_MODEL=<model-name>
ANTHROPIC_DEFAULT_SONNET_MODEL=<model-name>
ANTHROPIC_DEFAULT_OPUS_MODEL=<model-name>
```

**Note:** Provider must implement Anthropic Messages API format

## Step-by-Step Configuration

### Step 1: Backup Current Configuration

```bash
cp .env .env.backup
```

### Step 2: Choose Your Provider

AskUserQuestion: Which provider do you want to configure?
- **Option 1**: Anthropic Claude (default)
- **Option 2**: Zhipu GLM-5 (tested in production)
- **Option 3**: Custom Anthropic-compatible provider

### Step 3: Apply Provider Configuration

**For Anthropic (Option 1):**
- Check `.env` contains `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`
- No additional configuration needed
- Skip to Step 4

**For Zhipu GLM (Option 2):**
1. Get API key from https://open.bigmodel.cn/usercenter/apikeys
2. Add to `.env`:
   ```bash
   ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic
   ANTHROPIC_AUTH_TOKEN=<paste-token-here>
   ANTHROPIC_DEFAULT_HAIKU_MODEL=glm-5
   ANTHROPIC_DEFAULT_SONNET_MODEL=glm-5
   ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5
   ```

**For custom provider (Option 3):**
AskUserQuestion: What is your provider's API base URL?
AskUserQuestion: What is your auth token?

Add to `.env`:
```bash
ANTHROPIC_BASE_URL=<provider-url>
ANTHROPIC_AUTH_TOKEN=<provider-token>
```

### Step 4: Update Model Name Template (Optional)

**Only needed for:** Non-Anthropic providers with different model names

Edit `src/container-runner.ts` around line 115-136 (the `settings.json` template):

Find:
```typescript
env: {
  // Feature flags...
}
```

Add model overrides:
```typescript
env: {
  // ...existing feature flags...

  // Model name overrides for <provider-name>
  ANTHROPIC_DEFAULT_HAIKU_MODEL: '<model-name>',
  ANTHROPIC_DEFAULT_SONNET_MODEL: '<model-name>',
  ANTHROPIC_DEFAULT_OPUS_MODEL: '<model-name>',
}
```

### Step 5: Apply to Existing Groups (Optional)

The settings.json is only created on first container start. To apply model configuration to existing groups:

```bash
# List existing group settings
find data/sessions -name settings.json -path '*/.claude/*'

# For each group, update the model names
# (Manual step: edit each file to add ANTHROPIC_DEFAULT_*_MODEL entries)
```

Or regenerate all (WARNING: loses group-specific customizations):
```bash
find data/sessions -name settings.json -path '*/.claude/*' -delete
systemctl --user restart nanoclaw  # or launchctl on macOS
```

### Step 6: Rebuild and Restart

```bash
npm run build
systemctl --user restart nanoclaw  # Linux
# or: launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
```

### Step 7: Verify

Send a test message to confirm the new provider is working.

## Reverting to Anthropic Claude

To switch back to default Anthropic:

```bash
# Remove provider-specific config from .env
sed -i.bak '/ANTHROPIC_BASE_URL/d' .env
sed -i.bak '/ANTHROPIC_AUTH_TOKEN/d' .env
sed -i.bak '/ANTHROPIC_DEFAULT_.*_MODEL/d' .env

# Regenerate settings
find data/sessions -name settings.json -path '*/.claude/*' -delete

# Restart
systemctl --user restart nanoclaw
```

## Troubleshooting

**"Auth failed" error:**
- Check `.env` has correct `ANTHROPIC_AUTH_TOKEN` (or `ANTHROPIC_API_KEY`)
- Verify token hasn't expired
- Check container logs: `groups/*/logs/container-*.log`

**"Model not found" error:**
- Provider may use different model names
- Check provider's documentation for correct model IDs
- Update `ANTHROPIC_DEFAULT_*_MODEL` overrides

**"Different response quality":**
- Non-Claude models may not support all Claude Code features
- Test basic functionality first
- Some tool use patterns may not work as expected

**Settings not applied:**
- Settings.json is created once on first start
- Run Step 5 to update existing groups
- Or delete and restart to regenerate

## Provider Compatibility Notes

| Provider | API Compatibility | Model Support | Tested |
|----------|------------------|---------------|---------|
| Anthropic Claude | ✅ Native | ✅ Full (Haiku/Sonnet/Opus) | ✅ Production |
| Zhipu GLM-5 | ✅ Compatible via proxy | ⚠️ Single model (glm-5) | ✅ Production |
| Together AI | ✅ Compatible | ⚠️ Varies by model | ⏳ Untested |
| Fireworks | ✅ Compatible | ⏳ Untested | ⏳ Untested |
| Ollama (local) | ✅ Compatible (via proxy) | ⏳ Untested | ⏳ Untested |

## References

- **Upstream PR #592**: https://github.com/qwibitai/nanoclaw/pull/592
- **Anthropic API Docs**: https://docs.anthropic.com/
- **Zhipu GLM Docs**: https://open.bigmodel.cn/dev/api
