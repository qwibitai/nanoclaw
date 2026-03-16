# Changelog

All notable changes to NanoClaw will be documented in this file.

## [1.2.0](https://github.com/qwibitai/nanoclaw/compare/v1.1.6...v1.2.0)

[BREAKING] WhatsApp removed from core, now a skill. Run `/add-whatsapp` to re-add (existing auth/groups preserved).

- **fix:** Prevent scheduled tasks from executing twice when container runtime exceeds poll interval (#138, #669)

## [2.0.0](https://github.com/qwibitai/nanoclaw/compare/v1.2.0...v2.0.0)

### ⚠️ BREAKING CHANGES

**Runtime Migration: Claude Agent SDK → OpenCode**

NanoClaw has migrated from Anthropic's Claude Agent SDK to OpenCode SDK. This is a fundamental runtime change affecting all agent execution.

**Required Actions for Upgrading:**

1. **Install OpenCode CLI** (replaces `claude` command):

   ```bash
   npm install -g opencode
   # or: brew install opencode-ai/tap/opencode
   ```

2. **Install oh-my-opencode plugin** (required for context compaction):

   ```bash
   opencode plugins add oh-my-opencode
   ```

3. **Update LLM Configuration** (new JSON format):

   Old format (no longer supported):

   ```bash
   ANTHROPIC_BASE_URL=...
   ANTHROPIC_AUTH_TOKEN=...
   ```

   New format (OpenAI-compatible):

   ```bash
   # Option A: JSON config (recommended)
   NANOCLAW_LLM_CONFIG='{
     "provider": {
       "openai-compatible": {
         "options": {
           "baseURL": "http://localhost:1234/v1",
           "apiKey": "not-needed"
         }
       }
     },
     "model": "openai-compatible/your-model"
   }'

   # Option B: Legacy env vars (backward compatible)
   NANOCLAW_LLM_BASE_URL=http://localhost:1234/v1
   NANOCLAW_LLM_MODEL_ID=your-model
   ```

4. **Update container image**:

   ```bash
   ./container/build.sh
   ```

5. **Start using `opencode` instead of `claude`**:
   ```bash
   opencode
   # Then: /setup
   ```

### Added

- Generic LLM provider configuration via `NANOCLAW_LLM_CONFIG` JSON
- Support for any OpenAI-compatible LLM (LM Studio, Ollama, OpenRouter, etc.)
- `NANOCLAW_LLM_MODEL` override for quick model switching
- Circuit breaker for LLM endpoint resilience
- Per-invocation trace IDs for observability
- oh-my-opencode plugin integration for context compaction
- Comprehensive contract tests for host-container protocol

### Changed

- Agent runtime: Claude Agent SDK → OpenCode SDK
- CLI command: `claude` → `opencode`
- LLM configuration: Anthropic-specific → OpenAI-compatible generic
- Credential handling: Proxy-based → direct environment variable passing
- Provider config format: flat → nested `options` object

### Removed

- **Anthropic Claude Code runtime** (replaced by OpenCode)
- **Credential proxy** (no longer needed)
- **ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN** env vars (use NANOCLAW_LLM_CONFIG)
- **CLAUDE*CODE*\*** environment variables

### Deprecated (still supported)

- `NANOCLAW_LLM_BASE_URL`, `NANOCLAW_LLM_MODEL_ID`, `NANOCLAW_LLM_API_KEY` (use NANOCLAW_LLM_CONFIG instead)

### Migration Notes

- Existing sessions will be reset (new session IDs)
- Skills system (`.claude/skills/**/SKILL.md`) continues to work
- `CLAUDE.md` memory conventions preserved
- Per-group isolation unchanged
- All channels (WhatsApp, Telegram, etc.) work with new runtime
