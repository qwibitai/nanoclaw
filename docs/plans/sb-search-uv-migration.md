# Plan: Migrate sb-search from Rust CLI to Python package (uv)

## Context

The graham-second-brain group's `sb-search` skill currently installs the OpenViking `ov` CLI via a Rust install script (`curl | bash`). This is fragile and slow. The `openviking` Python package on PyPI (v0.2.13) provides the same `ov` CLI binary. Since `uv` is already in the container image and the group directory is mounted read-write, we can use `uv sync` with a `pyproject.toml` to install and persist the CLI in a `.venv/` that survives between container runs.

## Changes

### 1. Create `groups/graham-second-brain/pyproject.toml`

```toml
[project]
name = "graham-second-brain"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
    "openviking",
]
```

### 2. Update bootstrap in `groups/graham-second-brain/.claude/skills/sb-search/SKILL.md`

Replace the current bootstrap block (lines 12-21) that curls the Rust installer with:

```bash
# Install openviking into persistent venv (fast no-op if already installed)
cd /workspace/group && uv sync
export PATH="/workspace/group/.venv/bin:$PATH"

# Verify connectivity
export OV_CONFIG="/workspace/extra/.openviking/ovcli.conf"
ov status
```

**Why this works:**
- `uv sync` reads `pyproject.toml`, creates `.venv/` if needed, installs `openviking` — idempotent and fast (~200ms when already satisfied)
- PATH prepend (not venv activation) is correct since each bash call is a separate shell
- `.venv/` persists in the mounted group directory between container runs
- `.venv/` is already in `.gitignore`

### 3. No other changes

The rest of the skill (search, ingest, memory modes) stays identical — still uses `ov` CLI commands and `curl` for the HTTP API. The `API_KEY` parsing, PARA-scoped URIs, and progressive L0/L1/L2 retrieval are all unchanged.

## Files to modify

| File | Action |
|------|--------|
| `groups/graham-second-brain/pyproject.toml` | Create (new) |
| `groups/graham-second-brain/.claude/skills/sb-search/SKILL.md` | Edit bootstrap block |

## Verification

1. Rebuild is NOT needed (no container image changes)
2. Trigger the graham-second-brain agent and invoke `/sb-search` — confirm `uv sync` runs and `ov status` succeeds
3. Trigger again — confirm `uv sync` is a fast no-op (venv already satisfied)
