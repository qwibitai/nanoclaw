# Add Local LLM Support

Add hybrid LLM routing to NanoClaw - use local LLMs (LM Studio, Ollama) for simple queries and Claude for complex tasks.

## What This Skill Does

Installs local LLM integration that:
- Routes simple queries to local models (cost-free)
- Keeps Claude for tool use, agent teams, and complex reasoning
- Supports per-group provider configuration
- Provides multiple routing modes (simple, always, manual, hybrid)

## When to Use This

Use this skill when you want to:
- Reduce API costs by routing simple queries locally
- Run NanoClaw partially offline
- Use different models for different groups
- Experiment with local LLMs

## Installation

This is a **feature skill** - it merges code into your NanoClaw installation.

### Prerequisites

1. **NanoClaw running** - complete `/setup` first
2. **Local LLM server** (optional for testing):
   - LM Studio: Download from https://lmstudio.ai
   - Ollama: `brew install ollama` (macOS)

### Apply Skill

```bash
# From NanoClaw root directory
npx tsx scripts/apply-skill.ts .claude/skills/add-local-llm
npm run build
./container/build.sh
```

Restart NanoClaw:
```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

## Configuration

### Environment Variables

Add to `.env`:

```bash
# Provider selection
DEFAULT_LLM_PROVIDER=claude  # claude | lm-studio | ollama | openai-compatible

# LM Studio
LM_STUDIO_URL=http://localhost:1234/v1
LM_STUDIO_MODEL=qwen3-coder:7b

# Ollama
OLLAMA_URL=http://localhost:11434/v1
OLLAMA_MODEL=gemma3:1b

# Generic OpenAI-compatible
OPENAI_COMPATIBLE_URL=
OPENAI_COMPATIBLE_MODEL=
OPENAI_COMPATIBLE_API_KEY=

# Routing
DEFAULT_ROUTING_MODE=simple  # simple | always | manual | hybrid
DEFAULT_MAX_TOKENS_FOR_LOCAL=500
```

### Routing Modes

**simple** (recommended): Auto-route based on complexity
- Queries <500 tokens → local
- Tool use needed → Claude
- Multi-turn (>3 turns) → Claude

**always**: Use configured provider exclusively

**manual**: User controls with `@local` / `@claude` prefixes

**hybrid**: Let Claude classify complexity (adds latency)

## Usage

### Quick Start with LM Studio

1. **Install LM Studio**
   - Download from https://lmstudio.ai
   - Load a model (e.g., `gemma3:1b`)
   - Start server (Local Server tab)

2. **Configure NanoClaw**
   ```bash
   # Add to .env
   DEFAULT_LLM_PROVIDER=lm-studio
   LM_STUDIO_MODEL=gemma3:1b
   DEFAULT_ROUTING_MODE=simple
   ```

3. **Rebuild and restart** (commands above)

4. **Test**
   - Send: "What's 2+2?" → Routes to local
   - Check logs: `tail -f groups/main/logs/latest.log`
   - Look for: "Routing to local LLM: under token threshold"

### Per-Group Configuration

Use the `configure_llm_provider` MCP tool from the main group:

```
@Andy configure dev-team to use Ollama for simple queries
```

The agent will call:
```typescript
configure_llm_provider({
  provider: 'ollama',
  routing_mode: 'simple',
  base_url: 'http://localhost:11434/v1',
  model: 'gemma3:1b',
  max_tokens_for_local: 500
})
```

## Examples

### Example 1: Cost Optimization
**Setup**: `DEFAULT_ROUTING_MODE=simple` with LM Studio
**Result**:
- Simple questions → Free (local)
- Web searches, file operations → Claude
- Estimated savings: 20-30% of API costs

### Example 2: Offline Operation
**Setup**: `DEFAULT_ROUTING_MODE=always` with Ollama
**Result**:
- All queries to local model
- No API costs
- No internet required
- Limited to text responses (no tools)

### Example 3: Manual Control
**Setup**: `DEFAULT_ROUTING_MODE=manual`
**Usage**:
- `@local translate "hello" to Spanish` → Local
- `@claude search for papers on AI` → Claude
- `regular message` → Claude (default)

### Example 4: Multi-Group Strategy
- **Main group**: Claude only (full features)
- **Family group**: Ollama (simple chat)
- **Dev group**: LM Studio (code questions)

Configure each group separately using `configure_llm_provider`.

## Verification

### Check Routing Works

1. **Send simple query:**
   ```
   What's the capital of France?
   ```

2. **Check logs:**
   ```bash
   tail -f groups/main/logs/latest.log
   ```

3. **Look for:**
   - `Routing decision: local - Simple query: 6 tokens, no tools, 0 turns`
   - `Created new local session: ...`

4. **Send complex query:**
   ```
   @Andy search for recent AI papers
   ```

5. **Should see:**
   - `Routing decision: claude - Query contains tool keywords`

### Verify Fallback

1. **Stop local LLM server**
2. **Send simple query**
3. **Check logs:**
   - `Local LLM failed, falling back to Claude: ...`
   - Still get response from Claude

## Troubleshooting

### "Connection refused" errors

**Cause**: Local LLM server not running

**Fix**:
- LM Studio: Click "Start Server" in Local Server tab
- Ollama: Service auto-starts, check with `curl http://localhost:11434/api/tags`

### All queries go to Claude

**Possible causes**:
1. Routing mode is `manual` but no `@local` prefix
2. Token threshold too low (increase `DEFAULT_MAX_TOKENS_FOR_LOCAL`)
3. Query contains tool keywords (search, file, bash, etc.)
4. Multi-turn conversation (>3 turns)

**Debug**:
- Check logs for routing decisions
- Test with very simple query: "Hi"
- Verify `DEFAULT_ROUTING_MODE=simple` in `.env`

### Local LLM responses are slow

**Solutions**:
- Use smaller model (gemma3:1b instead of qwen3:14b)
- Lower `DEFAULT_MAX_TOKENS_FOR_LOCAL` (route less to local)
- Check system resources (CPU/RAM usage)

### Model not found

**Ollama**: Verify model pulled
```bash
ollama list
ollama pull gemma3:1b
```

**LM Studio**: Verify model loaded (not just downloaded)
- Check "Loaded Models" tab
- Click "Load Model" if needed

## Recommended Models

### Light & Fast (1-3GB RAM)
- `gemma3:1b` - Fast, good for simple queries
- `phi3:mini` - Microsoft's efficient model

### Code-Focused (7-10GB RAM)
- `qwen3-coder:7b` - Great for code questions
- `codellama:7b` - Meta's code model

### High Quality (14-20GB RAM)
- `qwen3:14b` - Better reasoning
- `llama3:8b` - Meta's general purpose

## Files Modified

This skill adds/modifies:

```
container/agent-runner/src/
├── llm-router.ts              (new - routing logic)
├── openai-client.ts           (new - OpenAI API client)
├── llm-session.ts             (new - session management)
├── index.ts                   (modified - integrate routing)
└── ipc-mcp-stdio.ts           (modified - add configure tool)

src/
├── types.ts                   (modified - add LLMProviderConfig)
├── config.ts                  (modified - add env variables)
├── container-runner.ts        (modified - pass config to container)
├── index.ts                   (modified - pass config from groups)
├── task-scheduler.ts          (modified - pass config for tasks)
├── ipc.ts                     (modified - handle configure_llm)
└── db.ts                      (modified - add updateGroupConfig)

docs/
└── LOCAL_LLM_GUIDE.md         (new - setup guide)
```

## Uninstallation

To remove local LLM support:

1. **Revert to Claude only:**
   ```bash
   # .env
   DEFAULT_LLM_PROVIDER=claude
   ```

2. **Or remove changes:**
   ```bash
   git log --oneline  # Find commit before skill
   git revert <commit-hash>
   npm run build
   ./container/build.sh
   ```

3. **Restart NanoClaw**

## Documentation

Full setup guide: [docs/LOCAL_LLM_GUIDE.md](../../../docs/LOCAL_LLM_GUIDE.md)

Topics covered:
- Provider installation (LM Studio, Ollama)
- Routing mode details
- Per-group configuration
- Cost savings analysis
- Troubleshooting
- Security notes

## Limitations

Local LLMs cannot:
- Use tools (Bash, Read, Write, WebSearch)
- Call MCP servers (send_message, schedule_task)
- Run agent teams / swarms
- Resume Claude SDK sessions

Queries requiring these features **always route to Claude**.

## Support

For issues:
1. Check logs: `tail -f groups/main/logs/latest.log`
2. Verify provider: `curl http://localhost:1234/v1/models`
3. Test simple mode: Send "What's 2+2?"
4. See [docs/LOCAL_LLM_GUIDE.md](../../../docs/LOCAL_LLM_GUIDE.md)
5. Report issues: https://github.com/anthropics/nanoclaw/issues

## Related Skills

- `/add-ollama-tool` - Add Ollama as an MCP tool (different from this skill)
- `/customize` - General customization guide
- `/debug` - Container debugging

## Version

Compatible with NanoClaw v2.0+
Requires Claude Agent SDK v1.0+
