/**
 * NanoClaw Agent Runner v2
 *
 * Runs inside a container. All IO goes through the session DB.
 * No stdin, no stdout markers, no IPC files.
 *
 * Config is read from /workspace/agent/container.json (mounted RO).
 * Only TZ and OneCLI networking vars come from env.
 *
 * Mount structure:
 *   /workspace/
 *     inbound.db        ← host-owned session DB (container reads only)
 *     outbound.db       ← container-owned session DB
 *     .heartbeat        ← container touches for liveness detection
 *     outbox/           ← outbound files
 *     agent/            ← agent group folder (CLAUDE.md, container.json, working files)
 *       container.json  ← per-group config (RO nested mount)
 *     global/           ← shared global memory (RO)
 *   /app/src/           ← shared agent-runner source (RO)
 *   /app/skills/        ← shared skills (RO)
 *   /home/node/.claude/ ← Claude SDK state + skill symlinks (RW)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { loadConfig } from './config.js';
import { touchHeartbeat } from './db/connection.js';
import { buildSystemPromptAddendum } from './destinations.js';
import { normalizeMcpEntry, type RawMcpEntry } from './mcp-config.js';
// Providers barrel — each enabled provider self-registers on import.
// Provider skills append imports to providers/index.ts.
import './providers/index.js';
import { createProvider, type ProviderName } from './providers/factory.js';
import { runPollLoop } from './poll-loop.js';
import type { McpServerConfig } from './providers/types.js';

function log(msg: string): void {
  console.error(`[agent-runner] ${msg}`);
}

const CWD = '/workspace/agent';

// Process-liveness heartbeat. The poll-loop touches heartbeat as events
// stream from the provider, which is fine for streaming providers (Claude SDK,
// Codex) but starves on request/response providers like amplifier-remote: a
// 90s synchronous HTTP wait yields no events, so the heartbeat goes stale and
// the host's claim-stuck sweep (60s tolerance) kills a perfectly healthy
// container mid-turn. Touching on a fixed 20s tick decouples liveness from
// provider event flow — if the Node event loop is running, the container is
// alive. Genuine deadlocks (pegged CPU, sync fs hang) still stop the timer.
const HEARTBEAT_TICK_MS = 20_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const providerName = config.provider.toLowerCase() as ProviderName;

  log(`Starting v2 agent-runner (provider: ${providerName})`);

  const heartbeatInterval = setInterval(touchHeartbeat, HEARTBEAT_TICK_MS);
  heartbeatInterval.unref();
  touchHeartbeat();

  // Runtime-generated system-prompt addendum: agent identity (name) plus
  // the live destinations map. Everything else (capabilities, per-module
  // instructions, per-channel formatting) is loaded by Claude Code from
  // /workspace/agent/CLAUDE.md — the composed entry imports the shared
  // base (/app/CLAUDE.md) and each enabled module's fragment. Per-group
  // memory lives in /workspace/agent/CLAUDE.local.md (auto-loaded).
  const instructions = buildSystemPromptAddendum(config.assistantName || undefined);

  // Discover additional directories mounted at /workspace/extra/*
  const additionalDirectories: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        additionalDirectories.push(fullPath);
      }
    }
    if (additionalDirectories.length > 0) {
      log(`Additional directories: ${additionalDirectories.join(', ')}`);
    }
  }

  // MCP server path — bun runs TS directly; no tsc build step in-image.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'mcp-tools', 'index.ts');

  // Build MCP servers config: nanoclaw built-in + any from container.json.
  // container.json entries may use either stdio (command/args) or URL-based
  // transports (type: 'http' | 'sse' | 'streamableHttp', url). normalizeMcpEntry
  // validates the entry, drops host-only fields (`instructions`), and maps
  // 'streamableHttp' → SDK 'http'. A bad entry is logged and skipped so one
  // typo in container.json doesn't take down the runner.
  const mcpServers: Record<string, McpServerConfig> = {
    nanoclaw: {
      command: 'bun',
      args: ['run', mcpServerPath],
      env: {},
    },
  };

  for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
    try {
      const normalized = normalizeMcpEntry(name, serverConfig as RawMcpEntry);
      mcpServers[name] = normalized;
      const transport = 'url' in normalized ? `${normalized.type} ${normalized.url}` : `stdio ${normalized.command}`;
      log(`Additional MCP server: ${name} (${transport})`);
    } catch (err) {
      log(`Skipping invalid MCP server '${name}': ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const provider = createProvider(providerName, {
    assistantName: config.assistantName || undefined,
    mcpServers,
    env: { ...process.env },
    additionalDirectories: additionalDirectories.length > 0 ? additionalDirectories : undefined,
  });

  await runPollLoop({
    provider,
    providerName,
    cwd: CWD,
    systemContext: { instructions },
  });
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
