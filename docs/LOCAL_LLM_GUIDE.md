# Local LLM Integration Guide

This guide explains how to use local LLMs (LM Studio, Ollama, or any OpenAI-compatible endpoint) with NanoClaw for cost-effective operation.

## Overview

NanoClaw supports hybrid LLM routing:
- **Claude (default)**: Advanced reasoning, tool use, agent teams, MCP servers
- **Local LLMs**: Fast, cost-free responses for simple queries

The router automatically decides which provider to use based on query complexity, or you can manually control routing.

## Quick Start

### Option 1: LM Studio (Recommended)

1. **Install LM Studio**
   - Download from https://lmstudio.ai
   - Available for macOS, Windows, Linux

2. **Load a Model**
   - Open LM Studio
   - Search for and download a small model (e.g., `qwen3-coder:7b`, `gemma3:1b`)
   - Smaller models (~1-7B parameters) work well for simple queries

3. **Start the Server**
   - Go to "Local Server" tab
   - Click "Start Server"
   - Default endpoint: `http://localhost:1234`

4. **Configure NanoClaw**

   Add to your `.env` file:
   ```bash
   DEFAULT_LLM_PROVIDER=lm-studio
   LM_STUDIO_URL=http://localhost:1234/v1
   LM_STUDIO_MODEL=qwen3-coder:7b
   DEFAULT_ROUTING_MODE=simple
   DEFAULT_MAX_TOKENS_FOR_LOCAL=500
   ```

5. **Restart NanoClaw**
   ```bash
   npm run build
   ./container/build.sh
   launchctl kickstart -k gui/$(id -u)/com.nanoclaw
   ```

### Option 2: Ollama

1. **Install Ollama**
   ```bash
   brew install ollama  # macOS
   # or download from https://ollama.ai
   ```

2. **Pull a Model**
   ```bash
   ollama pull gemma3:1b
   ```

3. **Configure NanoClaw**

   Add to your `.env` file:
   ```bash
   DEFAULT_LLM_PROVIDER=ollama
   OLLAMA_URL=http://localhost:11434/v1
   OLLAMA_MODEL=gemma3:1b
   DEFAULT_ROUTING_MODE=simple
   ```

4. **Restart NanoClaw** (same as above)

### Option 3: Generic OpenAI-Compatible API

For other providers (Ollama custom setup, local deployments, etc.):

```bash
DEFAULT_LLM_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_URL=http://your-endpoint/v1
OPENAI_COMPATIBLE_MODEL=your-model-name
OPENAI_COMPATIBLE_API_KEY=your-key-if-needed
DEFAULT_ROUTING_MODE=simple
```

## Routing Modes

### 1. Simple Mode (Default)

Automatically routes based on heuristics:
- **Local**: Queries under 500 tokens, no tool keywords, first 3 turns
- **Claude**: Long queries, tool use needed, complex conversations

```bash
DEFAULT_ROUTING_MODE=simple
DEFAULT_MAX_TOKENS_FOR_LOCAL=500  # Adjust threshold
```

**Examples:**
- "What's 2+2?" → Local
- "Search for AI news" → Claude (needs WebSearch tool)
- "Explain quantum computing in detail..." (>500 tokens) → Claude

### 2. Always Mode

Use the configured provider exclusively:

```bash
DEFAULT_ROUTING_MODE=always
```

**Use cases:**
- Test local LLM exclusively
- Force all queries to local for maximum cost savings
- Disable local routing (set `DEFAULT_LLM_PROVIDER=claude`)

### 3. Manual Mode

Control routing with message prefixes:

```bash
DEFAULT_ROUTING_MODE=manual
```

**Usage:**
- `@local what's the weather like today?` → Local LLM
- `@claude search for recent papers` → Claude
- `regular message` → Claude (default in manual mode)

### 4. Hybrid Mode (Experimental)

Uses Claude to classify query complexity before routing. Adds latency but improves routing accuracy.

```bash
DEFAULT_ROUTING_MODE=hybrid
```

## Per-Group Configuration

Configure different providers for different groups using the `configure_llm_provider` MCP tool:

```
User (in main group): "Configure the dev-team group to use Ollama for simple queries"

Agent calls:
configure_llm_provider({
  provider: 'ollama',
  routing_mode: 'simple',
  base_url: 'http://localhost:11434/v1',
  model: 'gemma3:1b',
  max_tokens_for_local: 500
})
```

**Per-group examples:**
- Main group: Claude (full features)
- Family group: Local Ollama (simple questions only)
- Work group: LM Studio with manual routing

## Understanding Routing Decisions

The router logs its decisions in container logs:

```bash
tail -f groups/main/logs/latest.log
```

Look for lines like:
- `Routing to local LLM: under token threshold`
- `Routing to Claude: needs tools`
- `Local LLM failed, falling back to Claude`

## Troubleshooting

### Local LLM Not Responding

1. **Check server is running:**
   - LM Studio: Verify "Server Running" indicator
   - Ollama: `curl http://localhost:11434/api/tags`

2. **Test endpoint manually:**
   ```bash
   curl http://localhost:1234/v1/models  # LM Studio
   curl http://localhost:11434/api/tags  # Ollama
   ```

3. **Check logs:**
   ```bash
   tail -f groups/main/logs/latest.log
   ```

### All Queries Go to Claude

1. **Verify routing mode:**
   ```bash
   grep ROUTING_MODE .env
   ```

2. **Check query complexity:**
   - Queries with tool keywords (search, file, bash) always use Claude
   - Queries over token threshold use Claude
   - Multi-turn conversations (>3 turns) use Claude

3. **Test with simple query:**
   - "What's 2+2?" should route to local if configured

### Model Loading Issues

**LM Studio:**
- Model must be loaded (not just downloaded)
- Check "Loaded Models" tab
- Try smaller model if RAM limited

**Ollama:**
- Verify model pulled: `ollama list`
- Check model name matches config: `gemma3:1b` not `gemma3:1-billion`

### Performance Issues

**Slow responses from local LLM:**
- Use smaller model (1B-7B parameters)
- Check CPU/GPU usage
- Reduce `DEFAULT_MAX_TOKENS_FOR_LOCAL` to route less to local

**High RAM usage:**
- Smaller model: `gemma3:1b` instead of `qwen3-coder:7b`
- Quantized models: Look for Q4, Q5 variants in LM Studio

## Recommended Models

### For Code Tasks
- **LM Studio**: `qwen3-coder:7b` (great for code, ~7GB RAM)
- **Ollama**: `codellama:7b` (optimized for code)

### For General Queries
- **LM Studio**: `gemma3:1b` (fast, light, ~1GB RAM)
- **Ollama**: `gemma3:1b` or `phi3:mini`

### For Better Quality
- **LM Studio**: `qwen3:14b` (higher quality, ~14GB RAM)
- **Ollama**: `llama3:8b`

## Cost Savings

Typical savings with `simple` routing mode:
- Simple queries (30% of traffic): $0 (local)
- Complex queries (70% of traffic): Claude API cost

**Example:**
- 1000 messages/month
- 300 simple → local (save ~$1.50)
- 700 complex → Claude ($3.50)
- **Total**: $3.50 vs $5.00 = 30% savings

Adjust `DEFAULT_MAX_TOKENS_FOR_LOCAL` and routing mode based on your usage patterns.

## Advanced Configuration

### Multiple Groups with Different Providers

```typescript
// Main group: Claude only
configure_llm_provider({ provider: 'claude' })

// Dev group: LM Studio for simple queries
configure_llm_provider({
  provider: 'lm-studio',
  routing_mode: 'simple',
  model: 'qwen3-coder:7b'
})

// Family group: Ollama, always local
configure_llm_provider({
  provider: 'ollama',
  routing_mode: 'always',
  model: 'gemma3:1b'
})
```

### Custom Token Thresholds

Fine-tune routing aggressiveness:

```bash
# Conservative (more Claude, higher quality)
DEFAULT_MAX_TOKENS_FOR_LOCAL=300

# Aggressive (more local, lower cost)
DEFAULT_MAX_TOKENS_FOR_LOCAL=1000
```

### Session Persistence

Local LLM sessions are stored in:
```
groups/{group-name}/.llm-sessions/{provider}-{session-id}.json
```

Sessions include:
- Last 10 messages for context
- Timestamps
- Provider metadata

Sessions auto-trim to keep size manageable.

## Limitations of Local LLMs

Local LLMs **do not support**:
- Tool calling (Bash, Read, Write, WebSearch, etc.)
- MCP servers (send_message, schedule_task, etc.)
- Agent teams / swarms
- Advanced reasoning for complex tasks

These queries **always route to Claude** regardless of routing mode.

## Security Notes

1. **Local LLMs have no outbound access** - they run entirely on your machine
2. **API keys never sent to local LLMs** - credential injection bypassed for local
3. **Session data stored locally** - in group folders, same security as Claude sessions

## Next Steps

- Monitor routing decisions in logs
- Adjust `DEFAULT_MAX_TOKENS_FOR_LOCAL` based on usage
- Experiment with different models
- Configure per-group providers for different use cases

For issues or questions, see [CONTRIBUTING.md](../CONTRIBUTING.md).
