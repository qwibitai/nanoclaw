---
name: convert-to-apple-container
description: Switch from Docker to Apple Container for macOS-native container isolation. Use when the user wants Apple Container instead of Docker, or is setting up on macOS and prefers the native runtime. Triggers on "apple container", "convert to apple container", "switch to apple container", or "use apple container".
---

# Convert to Apple Container

This skill switches NanoClaw's container runtime from Docker to Apple Container (macOS-only). It uses the skills engine for deterministic code changes, then walks through verification.

**What this changes:**
- Container runtime binary: `docker` → `container`
- Mount syntax: `-v path:path:ro` → `--mount type=bind,source=...,target=...,readonly`
- Startup check: `docker info` → `container system status` (with auto-start)
- Orphan detection: `docker ps --filter` → `container ls --format json`
- Build script default: `docker` → `container`

**What stays the same:**
- Dockerfile (shared by both runtimes)
- Container runner code (`src/container-runner.ts`)
- Mount security/allowlist validation
- All other functionality

## Prerequisites

Verify Apple Container is installed:

```bash
container --version && echo "Apple Container ready" || echo "Install Apple Container first"
```

If not installed:
- Download from https://github.com/apple/container/releases
- Install the `.pkg` file
- Verify: `container --version`

Apple Container requires macOS. It does not work on Linux.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `convert-to-apple-container` is in `applied_skills`, skip to Phase 3 (Verify). The code changes are already in place.

### Check current runtime

```bash
grep "CONTAINER_RUNTIME_BIN" src/container-runtime.ts
```

If it already shows `'container'`, the runtime is already Apple Container. Skip to Phase 3.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package. The package files are in this directory alongside this SKILL.md.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

Or call `initSkillsSystem()` from `skills-engine/migrate.ts`.

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/convert-to-apple-container
```

This deterministically:
- Replaces `src/container-runtime.ts` with the Apple Container implementation
- Replaces `src/container-runtime.test.ts` with Apple Container-specific tests
- Updates `container/build.sh` to default to `container` runtime
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/src/container-runtime.ts.intent.md` — what changed and invariants
- `modify/container/build.sh.intent.md` — what changed for build script

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Verify

### Ensure Apple Container runtime is running

```bash
container system status || container system start
```

### Build the container image

```bash
./container/build.sh
```

### Test basic execution

```bash
echo '{}' | container run -i --entrypoint /bin/echo nanoclaw-agent:latest "Container OK"
```

### Test readonly mounts

```bash
mkdir -p /tmp/test-ro && echo "test" > /tmp/test-ro/file.txt
container run --rm --entrypoint /bin/bash \
  --mount type=bind,source=/tmp/test-ro,target=/test,readonly \
  nanoclaw-agent:latest \
  -c "cat /test/file.txt && touch /test/new.txt 2>&1 || echo 'Write blocked (expected)'"
rm -rf /tmp/test-ro
```

Expected: Read succeeds, write fails with "Read-only file system".

### Test read-write mounts

```bash
mkdir -p /tmp/test-rw
container run --rm --entrypoint /bin/bash \
  -v /tmp/test-rw:/test \
  nanoclaw-agent:latest \
  -c "echo 'test write' > /test/new.txt && cat /test/new.txt"
cat /tmp/test-rw/new.txt && rm -rf /tmp/test-rw
```

Expected: Both operations succeed.

### Full integration test

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Send a message via WhatsApp and verify the agent responds.

## Troubleshooting

**Apple Container not found:**
- Download from https://github.com/apple/container/releases
- Install the `.pkg` file
- Verify: `container --version`

**Runtime won't start:**
```bash
container system start
container system status
```

**Image build fails:**
```bash
# Clean rebuild — Apple Container caches aggressively
container builder stop && container builder rm && container builder start
./container/build.sh
```

**Container can't write to mounted directories:**
Check directory permissions on the host. The container runs as uid 1000.

## Summary of Changed Files

| File | Type of Change |
|------|----------------|
| `src/container-runtime.ts` | Full replacement — Docker → Apple Container API |
| `src/container-runtime.test.ts` | Full replacement — tests for Apple Container behavior |
| `container/build.sh` | Default runtime: `docker` → `container` |
