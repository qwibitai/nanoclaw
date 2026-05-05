# Agent Provider Selection

Talon supports two agent providers: **Anthropic** (default, cloud) and **Ollama** (fully-local / air-gapped). Switching is `.env`-driven for single-tenant installs, with an optional per-group override for multi-tenant deployments.

## TL;DR

```bash
# /opt/talon/.env  (or repo root .env in dev)

# Default — Anthropic via OneCLI gateway. Leave unset, no action needed.
# TALON_PROVIDER=anthropic

# Air-gapped — redirect Claude SDK at a local Ollama instance.
TALON_PROVIDER=ollama
TALON_OLLAMA_BASE_URL=http://host.docker.internal:11434
TALON_OLLAMA_MODEL=llama3.3:70b
TALON_OLLAMA_API_KEY=ollama   # optional, defaults to "ollama"
```

Restart Talon. Every group inherits the provider.

## How it works under the hood

Ollama 0.4+ speaks the Anthropic `/v1/messages` API natively. When `TALON_PROVIDER=ollama`, the container-runner:

1. Skips the OneCLI credential gateway (no upstream secrets to inject).
2. Injects `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` env vars so the Claude Agent SDK redirects to Ollama.
3. Injects `NO_PROXY` for the Ollama host so any HTTPS_PROXY doesn't intercept the redirect.
4. Upserts `model` into the per-group `.claude/settings.json` so the SDK picks the local Ollama model.
5. Routes `api.anthropic.com` to `127.0.0.1` via `--add-host` to fail-closed on escape attempts.

When `TALON_PROVIDER=anthropic` (or unset), none of the above happens — the existing OneCLI gateway path handles authentication.

## Per-group overrides (multi-tenant)

For the rare case where one customer should run a different provider, drop a `container.json` into the group folder. See `docs/provider-examples/`. Per-group settings take precedence over `.env` defaults.

## Model selection

Native long-context models (no YaRN tricks needed):

| Model | Native ctx | Tool reliability | Min VRAM (Q4) |
|-------|-----------|------------------|----------------|
| `llama3.1:8b` | 128K | OK for simple flows; struggles on 100+ tool selection | ~6 GB |
| `qwen2.5:14b-instruct-1m` | 1M | Solid | ~10 GB |
| `qwen2.5:32b-instruct` | 32K native (no extension) | Reliable, self-corrects schemas | ~25 GB |
| `llama3.3:70b` | 128K | Best general-purpose, full Claude Code scaffold | ~50-60 GB |

Avoid `*-coder` variants — broken tool templates emit stringified JSON instead of `tool_use` blocks.

## Latency expectations

For the SOC-analyst preset (full Claude Code system prompt + 10 MCP servers + 100+ tool schemas):

| Stack | Per-turn (warm, with MCP tool) |
|-------|--------------------------------|
| Anthropic Claude (cloud) | 3-15 s |
| Ollama on H200 (70B) | 60-100 s |
| Ollama on A100 80GB (70B) | 80-120 s |
| Ollama on consumer 24GB (8B) | 10-20 s but tool discipline weak |

The cloud-vs-local gap is structural (no server-side prompt cache, no batching, no proprietary kernels). For interactive triage, Anthropic mode is the right default. For scheduled investigations or compliance-driven air-gap, Ollama works.

## Operator workflow examples

**Switching to Ollama:**

```bash
cat >> /opt/talon/.env <<'EOF'
TALON_PROVIDER=ollama
TALON_OLLAMA_BASE_URL=http://host.docker.internal:11434
TALON_OLLAMA_MODEL=llama3.3:70b
EOF

# Restart (macOS)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Restart (Linux)
systemctl --user restart nanoclaw
```

**Switching back to Anthropic:**

```bash
# Remove the Ollama lines from .env, then restart.
# The container-runner will strip the leftover `model` field from
# .claude/settings.json on next spawn — no manual cleanup needed.
```

## Failure modes & defenses

- **Ollama endpoint unreachable**: Container hangs and gets reaped by Talon's idle timeout. No fallback to Anthropic — fail-closed.
- **`api.anthropic.com` reachable from container**: Routed to 127.0.0.1 — DNS fails, request errors. Defense in depth.
- **Model emits hallucinated tool results**: Inspect the per-session JSONL at `data/sessions/<group>/.claude/projects/-workspace-group/<sessionId>.jsonl` — look for `tool_use` blocks vs plain text content. If only text, the model isn't calling tools (use a larger model).

## Verification smoke

```bash
# Unit: provider arg derivation (5 cases)
node scripts/smoke-provider-args.mjs

# Unit: .env loading + merge precedence (8 cases)
node scripts/smoke-env-provider.mjs

# Live: send a message via HTTP channel and watch container logs
curl -sS -X POST http://localhost:3100/message \
  -H 'x-api-key: <your HTTP_API_KEY>' -H 'content-type: application/json' \
  -d '{"message":"Reply with: PROVIDER-OK","sender":"smoketest"}'
```
