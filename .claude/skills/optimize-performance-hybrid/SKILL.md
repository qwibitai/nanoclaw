---
name: optimize-performance-hybrid
description: Enable hybrid architecture for 40% faster Main group responses via persistent container + AI-driven subagent spawning
---

# Optimize Performance (Hybrid Architecture)

Enable the hybrid architecture optimization for **40% faster Main group responses** by using a persistent container with AI-driven subagent spawning.

## Overview

**Performance Improvement:** ~10s → ~6s for typical conversational queries in Main group

**Architecture:**
```
Main Group Messages
       ↓
   Intelligent Router
       ↓
  ┌────┴────┐
  ↓         ↓
Persistent  Dedicated
Container   Container (Subagent)
(~6s)       (~10s)
  ↓         ↓
Simple      Complex/Risky
Queries     Operations
```

**How It Works:**
- **Persistent Container:** Long-running process for Main group eliminates 3s startup overhead (2s container + 1s SDK initialization)
- **AI-Driven Subagent Spawning:** Main agent autonomously decides when to spawn dedicated subagents via `spawn_subagent` MCP tool
- **Automatic Fallback:** If persistent container crashes 3+ times, automatically switches to traditional on-demand mode
- **Other Groups:** Unchanged (still use traditional on-demand containers)

## Prerequisites

Check if hybrid architecture is already enabled:

```bash
# Check environment configuration
grep ENABLE_PERSISTENT_MAIN .env

# Check if persistent container is running
docker ps | grep nanoclaw-main-persistent

# Check logs for persistent mode indicator
tail -50 logs/app.log | grep "persistent\|MainAgentManager"
```

**Expected Output (if enabled):**
- `.env` shows `ENABLE_PERSISTENT_MAIN=true` (or no entry = default enabled)
- Docker shows container `nanoclaw-main-persistent` in running state
- Logs show "Starting persistent container for Main group" and performance metrics

## Configuration

### Enable Hybrid Architecture (Default)

Hybrid architecture is **enabled by default**. To explicitly enable:

```bash
# Add to .env (or confirm it's not disabled)
echo "ENABLE_PERSISTENT_MAIN=true" >> .env

# Restart service
sudo systemctl restart nanoclaw

# Verify startup
tail -50 logs/app.log | grep MainAgentManager
```

### Performance Tuning

Optional environment variables in `.env`:

```bash
# Health check interval (default: 30000ms = 30s)
PERSISTENT_HEALTH_CHECK_INTERVAL=30000

# Request timeout (default: 300000ms = 5min)
PERSISTENT_REQUEST_TIMEOUT=300000

# Max restart attempts before fallback (default: 3)
PERSISTENT_MAX_RESTARTS=3
```

## Verification

### 1. Check Container Status

```bash
# Persistent container should be running
docker ps --filter "name=nanoclaw-main-persistent"

# Expected output:
# CONTAINER ID   IMAGE              STATUS         NAMES
# abc123def456   nanoclaw-agent     Up 2 minutes   nanoclaw-main-persistent
```

### 2. Monitor Logs

```bash
# Watch real-time logs
tail -f logs/app.log

# Look for:
# - "Starting persistent container for Main group"
# - "Main persistent container ready"
# - Performance metrics: "prepTime: Xms, agentTime: Xms, totalTime: Xms"
```

### 3. Performance Metrics

Send a simple query to Main group and check logs:

```bash
# Example log output for hybrid mode:
# [INFO] Processing message from Main (simple query)
# [INFO] Using persistent container for Main group
# [INFO] Response timing - prepTime: 50ms, agentTime: 5200ms, totalTime: 6100ms

# Example log output for subagent spawn:
# [INFO] Processing message from Main (complex query)
# [INFO] Main agent spawned subagent for complex operation
# [INFO] Response timing - prepTime: 2100ms, agentTime: 7800ms, totalTime: 10200ms
```

**Typical Response Times:**
- **Simple query (persistent):** 5-7s total (agentTime ~5-6s)
- **Complex query (subagent):** 9-12s total (includes 2s spawn overhead)
- **Traditional mode:** 9-11s total (always includes startup overhead)

## When Subagents Spawn

The **Main agent AI autonomously decides** when to spawn subagents using the `spawn_subagent` MCP tool. Common scenarios:

**Subagent Spawned (Dedicated Container):**
- File system operations (read/write/edit multiple files)
- Code execution or script running
- Long prompts (>2000 characters)
- Risky operations (git commits, database changes)
- Parallel task processing
- Memory-intensive operations

**Persistent Container Handles:**
- Conversational queries
- Information lookup
- Code explanations
- Planning discussions
- Quick file reads (<3 files)

**Example from logs:**
```
[INFO] Main agent decision: spawn_subagent
[INFO] Reason: User requested file modifications across multiple components
[INFO] Spawning dedicated container for task...
```

## Troubleshooting

### Persistent Container Not Starting

```bash
# Check logs for startup errors
tail -100 logs/app.log | grep -A 5 "MainAgentManager"

# Common issues:
# 1. Port conflict (if running multiple instances)
# 2. Docker daemon not running
# 3. Container image needs rebuild

# Rebuild container image
cd container && ./build.sh

# Restart service
sudo systemctl restart nanoclaw
```

### Container Keeps Crashing

```bash
# Check crash count in logs
grep "Persistent container crashed" logs/app.log | wc -l

# View crash details
grep -A 10 "Persistent container crashed" logs/app.log

# After 3 crashes, system auto-falls back to traditional mode:
# [WARN] Persistent container exceeded max restarts (3), falling back to traditional mode

# To reset crash counter, restart service:
sudo systemctl restart nanoclaw
```

### Slow Response Times

```bash
# Check performance metrics in logs
grep "Response timing" logs/app.log | tail -20

# If agentTime consistently high (>10s):
# 1. Check container resource usage
docker stats nanoclaw-main-persistent

# 2. Check if subagent spawning is working correctly
grep "spawn_subagent" logs/app.log

# 3. Verify Claude API latency (network issue)
# 4. Consider increasing timeout if legitimate long operations
```

### Health Check Failures

```bash
# Check health check logs
grep "Health check" logs/app.log | tail -20

# If frequent failures:
# [WARN] Main persistent container health check failed

# Increase health check interval in .env:
PERSISTENT_HEALTH_CHECK_INTERVAL=60000  # 60s instead of 30s

# Restart service
sudo systemctl restart nanoclaw
```

## Disabling (Rollback)

To completely disable hybrid architecture and return to traditional mode:

```bash
# 1. Set environment variable
echo "ENABLE_PERSISTENT_MAIN=false" >> .env

# 2. Restart service
sudo systemctl restart nanoclaw

# 3. Verify persistent container stopped
docker ps | grep nanoclaw-main-persistent
# (should show nothing)

# 4. Confirm traditional mode in logs
tail -50 logs/app.log | grep "Starting container for Main"
# (should show on-demand spawning for each message)
```

**Rollback is instant** - no code changes needed, just toggle environment variable.

## Implementation Details

### Files Modified

| File | Purpose |
|------|---------|
| `src/main-agent-manager.ts` | Persistent container lifecycle management |
| `src/index.ts` | Intelligent routing, subagent spawn handling |
| `src/types.ts` | Persistent request/response type definitions |
| `container/Dockerfile` | Support for persistent entrypoint mode |
| `container/agent-runner/src/ipc-mcp.ts` | `spawn_subagent` MCP tool implementation |
| `groups/main/CLAUDE.md` | Agent instructions for hybrid architecture |

### Architecture Components

**MainAgentManager Class** (`src/main-agent-manager.ts`):
- Spawns and manages long-running Docker container
- Handles stdin/stdout JSON communication
- Health checks every 30s with auto-restart
- Exponential backoff on crashes (1s, 2s, 4s delays)
- Automatic fallback after 3 failed restarts

**Intelligent Router** (`src/index.ts`):
- Routes Main group messages to persistent container
- Handles `spawn_subagent` responses from Main agent
- Spawns dedicated containers for subagent tasks
- Collects performance metrics (prepTime, agentTime, totalTime)

**spawn_subagent MCP Tool** (`ipc-mcp.ts`):
- Exposed to Main agent via Model Context Protocol
- Main agent AI decides when to invoke
- Parameters: task description, context, priority
- Returns: subagent spawned confirmation

### Performance Metrics

**Tracked Timings:**
- `prepTime`: Container startup + SDK initialization (0ms for persistent, ~2000ms for subagent)
- `agentTime`: Claude API processing time (~5000-8000ms typical)
- `totalTime`: End-to-end response time (prepTime + agentTime + overhead)

**Logged Format:**
```
[INFO] Response timing - prepTime: 50ms, agentTime: 5200ms, totalTime: 6100ms
```

## Benefits

✅ **40% faster responses** for typical Main group queries
✅ **AI-driven optimization** - agent chooses best execution mode
✅ **Automatic fallback** - no manual intervention on failures
✅ **Zero config** - works out of the box (default enabled)
✅ **Instant rollback** - single environment variable toggle
✅ **Isolation maintained** - complex operations still get dedicated containers
✅ **Resource efficient** - only one persistent container (Main group)

## Related Skills

- `/debug` - Troubleshoot container issues
- `/customize` - Modify hybrid architecture behavior
- `/setup` - Initial installation and configuration

---

**Note:** This optimization only affects the Main group. Other groups continue using traditional on-demand containers to maintain isolation and resource efficiency.
