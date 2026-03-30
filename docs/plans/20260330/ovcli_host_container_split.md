# Move ovcli.conf: Host-local vs Container-network Split

## Context

`~/.openviking/ovcli.conf` currently points to `http://sb-openviking:1933` (Docker network hostname). This works for agent containers on the `nanoclaw` network but fails from the host machine, where the OV server is reachable at `localhost:1933`. Morgan wants to use `ov` commands from the host too.

**Solution**: Two copies of `ovcli.conf` with different URLs:
- **Host**: `~/.openviking/ovcli.conf` → `http://localhost:1933`
- **Containers**: `~/.SB_PERSONAL/ovcli.conf` → `http://sb-openviking:1933` (already mounted into containers)

Since `.SB_PERSONAL` is already mounted R/W at `/workspace/extra/.SB_PERSONAL/`, the `~/.openviking` mount becomes unnecessary for containers.

## Changes

### 1. Update `~/.openviking/ovcli.conf` (host version)

Change URL from `http://sb-openviking:1933` to `http://localhost:1933`. API key stays the same.

```json
{
  "url": "http://localhost:1933",
  "api_key": "<unchanged>"
}
```

### 2. Create `~/.SB_PERSONAL/ovcli.conf` (container version)

Copy the current content (with `sb-openviking:1933` URL) to `~/.SB_PERSONAL/ovcli.conf`.

```json
{
  "url": "http://sb-openviking:1933",
  "api_key": "<same key>"
}
```

### 3. Gitignore `ovcli.conf` in `.SB_PERSONAL`

Create/update `~/.SB_PERSONAL/.gitignore` to exclude `ovcli.conf` (contains API key).

### 4. Update sb-search skill bootstrap path and instructions

**File**: `groups/graham-second-brain/.claude/skills/sb-search/SKILL.md`

- Change the config env var path from `/workspace/extra/.openviking/ovcli.conf` to `/workspace/extra/.SB_PERSONAL/ovcli.conf`
- Update any instructions/comments that reference the old `.openviking` mount location to reflect the new `.SB_PERSONAL` location

### 5. Remove `~/.openviking` mount from container config

Update the `graham-second-brain` group in `store/messages.db` — remove the `~/.openviking` additional mount from `container_config` JSON. The `.SB_PERSONAL` mount already provides the ovcli.conf.

New `container_config`:
```json
{
  "dockerNetwork": "nanoclaw",
  "additionalMounts": [
    {"hostPath": "~/.SB_PERSONAL", "containerPath": ".SB_PERSONAL", "readonly": false}
  ]
}
```

### 6. Optionally clean up mount allowlist

Remove `~/.openviking` from `~/.config/nanoclaw/mount-allowlist.json` since no group needs it mounted anymore. (Can keep if Morgan wants it available for future groups.)

### 7. Create `~/.SB_PERSONAL/README.md`

Succinct README with setup steps for the SB_PERSONAL repo, including:
- What the repo is (PARA second brain + OpenViking integration)
- How to create `ovcli.conf` for connecting to OpenViking
- The two connection modes: **local** (`http://localhost:1933` — for running `ov` commands from the host) vs **networked** (`http://sb-openviking:1933` — for agent containers on the NanoClaw Docker network)
- Docker Compose setup for the OpenViking sidecar

## Verification

1. From host: `OPENVIKING_CLI_CONFIG_FILE=~/.openviking/ovcli.conf ov status` — should connect via localhost
2. Trigger a `graham-second-brain` agent message — verify it uses `/workspace/extra/.SB_PERSONAL/ovcli.conf` and connects via `sb-openviking:1933`
3. Confirm `~/.SB_PERSONAL/ovcli.conf` is gitignored: `cd ~/.SB_PERSONAL && git status`

## Files

| File | Action |
|------|--------|
| `~/.openviking/ovcli.conf` | Update URL to localhost |
| `~/.SB_PERSONAL/ovcli.conf` | New — container-network version |
| `~/.SB_PERSONAL/.gitignore` | New — exclude ovcli.conf |
| `~/.SB_PERSONAL/README.md` | New — setup steps with connection mode details |
| `groups/graham-second-brain/.claude/skills/sb-search/SKILL.md` | Update config path and instructions |
| `store/messages.db` | Update group containerConfig (remove .openviking mount) |
| `~/.config/nanoclaw/mount-allowlist.json` | Optional — remove .openviking entry |
