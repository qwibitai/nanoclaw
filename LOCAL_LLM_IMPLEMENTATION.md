# Local LLM Integration - Implementation Summary

This document summarizes the Local LLM integration feature added to NanoClaw, with clear examples of how to use it.

## Overview

NanoClaw now supports hybrid LLM routing, allowing you to:
- **Route simple queries to local LLMs** (LM Studio, Ollama) for cost savings
- **Keep Claude for complex tasks** that need tools, agent teams, or advanced reasoning
- **Configure different providers per group** for flexible usage patterns
- **Automatically fallback to Claude** if local LLM fails

## Architecture

```
User Message
     ↓
Router analyzes query
     ↓
     ├─→ Simple query (< 500 tokens, no tools) → Local LLM
     │                                              ↓
     │                                         OpenAI Client
     │                                              ↓
     │                                         Local Session
     │
     └─→ Complex query (tools, long, multi-turn) → Claude SDK
                                                      ↓
                                                 Full features
```

## Implementation Details

### New Components

1. **llm-router.ts**: Routes queries based on complexity heuristics
2. **openai-client.ts**: Communicates with OpenAI-compatible APIs
3. **llm-session.ts**: Manages conversation history for local LLMs
4. **configure_llm_provider**: MCP tool for runtime configuration

### Modified Components

- `src/types.ts`: Added `LLMProviderConfig` interface
- `src/config.ts`: Added environment variables
- `src/index.ts`: Pass provider config from groups
- `container/agent-runner/src/index.ts`: Integrated routing with fallback
- `src/ipc.ts`: Handle configuration changes
- `src/db.ts`: Store provider config per group

## Quick Start Examples

### Example 1: Basic LM Studio Setup

**Step 1**: Install and configure LM Studio

```bash
# Download LM Studio from https://lmstudio.ai
# Load a model (e.g., gemma3:1b)
# Start the server (Local Server tab)
```

**Step 2**: Configure NanoClaw

Add to your `.env` file:

```bash
DEFAULT_LLM_PROVIDER=lm-studio
LM_STUDIO_URL=http://localhost:1234/v1
LM_STUDIO_MODEL=gemma3:1b
DEFAULT_ROUTING_MODE=simple
DEFAULT_MAX_TOKENS_FOR_LOCAL=500
```

**Step 3**: Build and restart

```bash
npm run build
./container/build.sh

# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

**Step 4**: Test it

Send a simple message:
```
What's 2+2?
```

Check logs:
```bash
tail -f groups/main/logs/latest.log
```

You should see:
```
Routing decision: local - Simple query: 6 tokens, no tools, 0 turns
Created new local session: 1234567890-abc123
```

### Example 2: Ollama Setup

**Step 1**: Install Ollama

```bash
# macOS
brew install ollama

# Linux
curl -fsSL https://ollama.ai/install.sh | sh
```

**Step 2**: Pull a model

```bash
ollama pull gemma3:1b
```

**Step 3**: Configure NanoClaw

```bash
# .env
DEFAULT_LLM_PROVIDER=ollama
OLLAMA_URL=http://localhost:11434/v1
OLLAMA_MODEL=gemma3:1b
DEFAULT_ROUTING_MODE=simple
```

**Step 4**: Rebuild, restart, and test (same as Example 1)

### Example 3: Manual Routing with Prefixes

**Configuration**:

```bash
# .env
DEFAULT_LLM_PROVIDER=lm-studio
LM_STUDIO_MODEL=qwen3-coder:7b
DEFAULT_ROUTING_MODE=manual  # <-- Manual mode
```

**Usage**:

```
# Force local LLM
@local what's the weather like today?

# Force Claude
@claude search for recent AI papers

# No prefix = Claude (default in manual mode)
Tell me about quantum computing
```

**What happens**:
- `@local` prefix → Always routes to local LLM
- `@claude` prefix → Always routes to Claude
- No prefix → Routes to Claude by default

### Example 4: Per-Group Configuration

Configure different providers for different groups.

**Step 1**: Configure main group (via WhatsApp/Telegram to @Andy)

```
@Andy configure this group to use Claude only
```

Agent response:
```
LLM provider set to Claude (default). All queries will use Claude API.
```

**Step 2**: Configure dev-team group

```
@Andy configure dev-team to use LM Studio for simple queries
```

Agent calls `configure_llm_provider`:
```typescript
{
  provider: 'lm-studio',
  routing_mode: 'simple',
  base_url: 'http://localhost:1234/v1',
  model: 'qwen3-coder:7b',
  max_tokens_for_local: 500
}
```

**Step 3**: Configure family group (always local)

```
@Andy configure family-chat to always use Ollama
```

Agent response:
```
LLM provider configured: ollama
Base URL: http://localhost:11434/v1
Model: gemma3:1b
Routing mode: always
Max tokens for local: 500
```

**Result**:
- **Main group**: Claude for everything (full features)
- **Dev-team**: LM Studio for simple queries, Claude for tools
- **Family-chat**: Ollama for all queries (no API costs)

### Example 5: Cost Optimization Strategy

**Goal**: Reduce API costs by 30-40% while maintaining quality

**Configuration**:

```bash
# .env
DEFAULT_LLM_PROVIDER=lm-studio
LM_STUDIO_MODEL=gemma3:1b
DEFAULT_ROUTING_MODE=simple
DEFAULT_MAX_TOKENS_FOR_LOCAL=500  # Tune this threshold
```

**What gets routed where**:

| Query | Routing Decision | Cost |
|-------|-----------------|------|
| "What's 2+2?" | Local (< 500 tokens, no tools) | $0 |
| "Explain Python decorators" | Local (simple explanation) | $0 |
| "@Andy search for AI news" | Claude (needs WebSearch tool) | ~$0.02 |
| "Read file.txt and summarize" | Claude (needs Read tool) | ~$0.03 |
| "Schedule a reminder..." | Claude (needs schedule_task MCP) | ~$0.02 |

**Expected savings**:
- 30-40% of queries route to local → 30-40% cost reduction
- Complex queries still get Claude's full capabilities

### Example 6: Testing Fallback Behavior

**Scenario**: Local LLM fails, NanoClaw automatically falls back to Claude

**Step 1**: Configure local LLM

```bash
# .env
DEFAULT_LLM_PROVIDER=lm-studio
DEFAULT_ROUTING_MODE=simple
```

**Step 2**: Start NanoClaw with LM Studio running

**Step 3**: Send a simple query

```
What's the capital of France?
```

Logs show:
```
Routing decision: local - Simple query: 7 tokens, no tools, 0 turns
```

Response: "Paris" (from local LLM)

**Step 4**: Stop LM Studio server

**Step 5**: Send another simple query

```
What's the capital of Spain?
```

Logs show:
```
Routing decision: local - Simple query: 7 tokens, no tools, 0 turns
Local LLM error: Failed to connect to http://localhost:1234/v1: ...
Local LLM failed, falling back to Claude: ...
```

Response: "Madrid" (from Claude fallback)

**Result**: No user-visible error, seamless fallback

## Routing Modes Explained

### 1. Simple Mode (Recommended)

**Configuration**:
```bash
DEFAULT_ROUTING_MODE=simple
DEFAULT_MAX_TOKENS_FOR_LOCAL=500
```

**Decision Logic**:
```
If query > 500 tokens          → Claude
If query has tool keywords     → Claude
If conversation > 3 turns      → Claude
Otherwise                      → Local LLM
```

**Tool keywords**: search, browse, web, fetch, file, read, write, edit, bash, command, run, execute, script, schedule, remind, task, cron

**Example queries**:

| Query | Tokens | Tools? | Turns | Decision |
|-------|--------|--------|-------|----------|
| "Hi" | ~1 | No | 0 | Local |
| "What's 2+2?" | ~6 | No | 0 | Local |
| "Explain quantum physics..." (long) | ~800 | No | 0 | Claude |
| "Search for papers" | ~5 | Yes (search) | 0 | Claude |
| Multi-turn conversation | ~50 | No | 4 | Claude |

### 2. Always Mode

**Configuration**:
```bash
DEFAULT_ROUTING_MODE=always
```

**Behavior**: Use configured provider exclusively (never switch)

**Use cases**:
- Force all queries to local (offline operation, no API costs)
- Force all queries to Claude (disable local routing)
- Testing a single provider

**Example**:
```bash
# Always use local
DEFAULT_LLM_PROVIDER=ollama
DEFAULT_ROUTING_MODE=always
```

**Limitation**: Local LLMs cannot use tools, so tool-requiring queries will fail instead of falling back to Claude.

### 3. Manual Mode

**Configuration**:
```bash
DEFAULT_ROUTING_MODE=manual
```

**Behavior**: User controls routing with message prefixes

**Syntax**:
- `@local <message>` → Route to local LLM
- `@claude <message>` → Route to Claude
- `<message>` (no prefix) → Route to Claude (default)

**Example conversation**:
```
User: @local translate "hello" to Spanish
Bot: [via local LLM] "Hola"

User: @claude search for recent AI papers
Bot: [via Claude with WebSearch] Here are recent papers...

User: what about ML papers?
Bot: [via Claude] Here are ML papers... [continues with Claude]
```

### 4. Hybrid Mode (Experimental)

**Configuration**:
```bash
DEFAULT_ROUTING_MODE=hybrid
```

**Behavior**: Makes a meta-call to Claude to classify query complexity, then routes accordingly

**Pros**: More accurate routing decisions
**Cons**: Adds latency (extra API call), costs more

**When to use**: When routing accuracy is critical and you want minimal mis-routing

## Configuration Reference

### Environment Variables

```bash
# Provider Selection
DEFAULT_LLM_PROVIDER=claude  # Options: claude | lm-studio | ollama | openai-compatible

# LM Studio Configuration
LM_STUDIO_URL=http://localhost:1234/v1
LM_STUDIO_MODEL=qwen3-coder:7b
LM_STUDIO_API_KEY=  # Usually not needed for local

# Ollama Configuration
OLLAMA_URL=http://localhost:11434/v1
OLLAMA_MODEL=gemma3:1b

# Generic OpenAI-Compatible Configuration
OPENAI_COMPATIBLE_URL=
OPENAI_COMPATIBLE_MODEL=
OPENAI_COMPATIBLE_API_KEY=

# Routing Configuration
DEFAULT_ROUTING_MODE=simple  # Options: simple | always | manual | hybrid
DEFAULT_MAX_TOKENS_FOR_LOCAL=500  # Threshold for simple mode
```

### Per-Group Configuration via MCP

Use the `configure_llm_provider` tool from the main group:

```typescript
// Configure a group to use LM Studio
configure_llm_provider({
  provider: 'lm-studio',
  routing_mode: 'simple',
  base_url: 'http://localhost:1234/v1',
  model: 'qwen3-coder:7b',
  max_tokens_for_local: 500
})

// Configure a group to use Ollama (always local)
configure_llm_provider({
  provider: 'ollama',
  routing_mode: 'always',
  base_url: 'http://localhost:11434/v1',
  model: 'gemma3:1b'
})

// Configure a group to use Claude only
configure_llm_provider({
  provider: 'claude'
})
```

## Recommended Models

### Light & Fast (1-3GB RAM)
- **gemma3:1b** - Google's efficient model, great for simple queries
- **phi3:mini** - Microsoft's compact model, good quality/size ratio

### Code-Focused (7-10GB RAM)
- **qwen3-coder:7b** - Excellent for code questions and explanations
- **codellama:7b** - Meta's code-specialized model

### High Quality (14-20GB RAM)
- **qwen3:14b** - Better reasoning, handles more complex queries
- **llama3:8b** - Meta's general-purpose model, good balance

### Recommendation by Use Case

| Use Case | Model | Provider |
|----------|-------|----------|
| Quick answers | gemma3:1b | Ollama |
| Code questions | qwen3-coder:7b | LM Studio |
| General chat | llama3:8b | Ollama |
| Maximum quality | qwen3:14b | LM Studio |

## Monitoring and Debugging

### Check Routing Decisions

```bash
# Watch logs in real-time
tail -f groups/main/logs/latest.log

# Or for specific group
tail -f groups/dev-team/logs/latest.log
```

**Look for these log lines**:

```
# Successful local routing
Routing decision: local - Simple query: 6 tokens, no tools, 0 turns
Created new local session: 1711234567890-abc123

# Claude routing (tools needed)
Routing decision: claude - Query contains tool keywords

# Claude routing (query too long)
Routing decision: claude - Query too long: 850 tokens > 500

# Fallback scenario
Local LLM error: Failed to connect to http://localhost:1234/v1
Local LLM failed, falling back to Claude: ...
```

### Check Session Files

Local LLM sessions are stored at:
```
groups/{group-name}/.llm-sessions/{provider}-{session-id}.json
```

Example:
```bash
cat groups/main/.llm-sessions/lm-studio-1711234567890-abc123.json
```

Contents:
```json
{
  "sessionId": "1711234567890-abc123",
  "provider": "lm-studio",
  "messages": [
    {
      "role": "user",
      "content": "What's 2+2?",
      "timestamp": "2026-03-28T12:00:00.000Z"
    },
    {
      "role": "assistant",
      "content": "2+2 equals 4.",
      "timestamp": "2026-03-28T12:00:01.234Z"
    }
  ],
  "createdAt": "2026-03-28T12:00:00.000Z",
  "updatedAt": "2026-03-28T12:00:01.234Z"
}
```

## Troubleshooting Examples

### Problem: All queries go to Claude

**Symptoms**:
- Logs show "Routing decision: claude" for every query
- No local LLM sessions created

**Debug steps**:

1. Check routing mode:
```bash
grep ROUTING_MODE .env
# Should show: DEFAULT_ROUTING_MODE=simple
```

2. Check provider:
```bash
grep DEFAULT_LLM_PROVIDER .env
# Should NOT be: DEFAULT_LLM_PROVIDER=claude
```

3. Test with very simple query:
```
Hi
```

4. Check logs for routing reason:
```bash
tail -f groups/main/logs/latest.log | grep "Routing decision"
```

**Common causes**:
- Routing mode is `manual` but no `@local` prefix used
- Token threshold too low (all queries exceed it)
- Queries contain tool keywords (search, file, bash, etc.)

### Problem: "Connection refused" errors

**Symptoms**:
```
Local LLM error: Failed to connect to http://localhost:1234/v1
```

**Solutions**:

1. **LM Studio**: Check server is running
   - Open LM Studio
   - Go to "Local Server" tab
   - Verify "Server Running" indicator (green)
   - Click "Start Server" if stopped

2. **Ollama**: Check service status
```bash
# Check if Ollama is responding
curl http://localhost:11434/api/tags

# Should return JSON with list of models
```

3. **Verify URL in config**:
```bash
# LM Studio default
curl http://localhost:1234/v1/models

# Ollama default
curl http://localhost:11434/v1/models
```

### Problem: Slow responses from local LLM

**Solutions**:

1. **Use smaller model**:
```bash
# Before (slow)
LM_STUDIO_MODEL=qwen3:14b

# After (faster)
LM_STUDIO_MODEL=gemma3:1b
```

2. **Reduce routing threshold** (send less to local):
```bash
# Before
DEFAULT_MAX_TOKENS_FOR_LOCAL=500

# After (more selective)
DEFAULT_MAX_TOKENS_FOR_LOCAL=200
```

3. **Check system resources**:
```bash
# macOS
top -o cpu

# Linux
htop
```

Look for high CPU or RAM usage.

## Files Modified/Created

### New Files
```
container/agent-runner/src/
├── llm-router.ts              # Routing logic
├── openai-client.ts           # OpenAI API client
└── llm-session.ts             # Session management

docs/
├── LOCAL_LLM_GUIDE.md         # Detailed setup guide
└── LOCAL_LLM_IMPLEMENTATION.md # This file

.claude/skills/add-local-llm/
└── SKILL.md                   # Feature skill documentation
```

### Modified Files
```
src/
├── types.ts                   # Added LLMProviderConfig
├── config.ts                  # Added env variables
├── container-runner.ts        # Pass config to container
├── index.ts                   # Pass config from groups
├── task-scheduler.ts          # Pass config for tasks
├── ipc.ts                     # Handle configure_llm
└── db.ts                      # Add updateGroupConfig

container/agent-runner/src/
├── index.ts                   # Integrate routing
└── ipc-mcp-stdio.ts           # Add configure tool
```

## Next Steps

1. **Build the project**:
```bash
npm install  # Resolve npm auth first if needed
npm run build
./container/build.sh
```

2. **Set up a local LLM**:
   - Install LM Studio or Ollama (see Quick Start examples)
   - Load/pull a model
   - Start the server

3. **Configure NanoClaw**:
   - Add environment variables to `.env`
   - Choose routing mode

4. **Test**:
   - Send simple queries
   - Check logs for routing decisions
   - Verify fallback works (stop local LLM)

5. **Optimize**:
   - Monitor which queries route where
   - Adjust `DEFAULT_MAX_TOKENS_FOR_LOCAL`
   - Configure per-group providers as needed

## Additional Resources

- **Full Setup Guide**: `docs/LOCAL_LLM_GUIDE.md`
- **Feature Skill**: `.claude/skills/add-local-llm/SKILL.md`
- **LM Studio**: https://lmstudio.ai
- **Ollama**: https://ollama.ai

## Support

For issues or questions:
1. Check logs: `tail -f groups/main/logs/latest.log`
2. Review troubleshooting section above
3. See detailed guide: `docs/LOCAL_LLM_GUIDE.md`
4. Report issues: https://github.com/anthropics/nanoclaw/issues
