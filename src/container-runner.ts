/**
 * Container Runner v2
 * Spawns agent containers with session folder + agent group folder mounts.
 * The container runs the v2 agent-runner which polls the session DB.
 */
import { ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import { getHostCapabilities } from './capabilities.js';
import {
  CONTAINER_IMAGE,
  CONTAINER_IMAGE_BASE,
  CONTAINER_INSTALL_LABEL,
  CONTAINER_MEMORY_LIMIT,
  CONTAINER_MEMORY_RESERVATION,
  CONTAINER_MEMORY_SWAP_LIMIT,
  CONTAINER_PIDS_LIMIT,
  DATA_DIR,
  GROUPS_DIR,
  MAX_CONCURRENT_CONTAINERS,
  ONECLI_API_KEY,
  ONECLI_URL,
  TIMEZONE,
} from './config.js';
import { readContainerConfig, writeContainerConfig, type ContainerConfig } from './container-config.js';
import { CONTAINER_RUNTIME_BIN, hostGatewayArgs, readonlyMountArgs, stopContainer } from './container-runtime.js';
import { composeGroupClaudeMd } from './claude-md-compose.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getDb, hasTable } from './db/connection.js';
import { findSessionByAgentGroupAndMessagingGroup } from './db/sessions.js';
import { buildArchiveProjection, buildCentralProjection } from './db/per-agent-projections.js';
import { initGroupFilesystem } from './group-init.js';
import { stopTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import { validateAdditionalMounts } from './modules/mount-security/index.js';
import YAML from 'yaml';

import { extractToolScopes, filterConfigSections, isToolEnabled } from './scoped-env.js';
// Provider host-side config barrel — each provider that needs host-side
// container setup self-registers on import.
import './providers/index.js';
import {
  getProviderContainerConfig,
  type ProviderContainerContribution,
  type VolumeMount,
} from './providers/provider-container-registry.js';
import { getSessionClaudeMounts } from './session-claude-mounts.js';
import {
  heartbeatPath,
  markContainerRunning,
  markContainerStopped,
  sessionDir,
  writeSessionRouting,
} from './session-manager.js';
import type { AgentGroup, Session } from './types.js';

const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

// Default model + effort. SINGLE source of truth for what containers
// resolve `opus` / `sonnet` / `haiku` aliases to and what reasoning
// effort they use when the user hasn't specified anything.
//
// To change the install-wide default, edit these constants. Per-channel
// (messaging_group_agents.default_model/effort) and per-group
// (container.json defaultModel/defaultEffort) layers can still override.
// Per-session flags (-m / -e) and sticky config override on top of those.
const DEFAULT_OPUS_MODEL = 'claude-opus-4-7[1m]';
const DEFAULT_SONNET_MODEL = 'claude-sonnet-4-6';
const DEFAULT_HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_EFFORT = 'high';

/** Active containers tracked by session ID. */
const activeContainers = new Map<string, { process: ChildProcess; containerName: string; spawnedAt: number }>();

/**
 * Wall-clock time the host spawned the container for this session, or 0 if
 * no container is tracked. Read by the host-sweep stuck-claim guard so a
 * fresh container gets a grace window to clear its own pre-existing
 * processing_ack rows before the SLA enforcer kills it.
 */
export function getContainerSpawnedAt(sessionId: string): number {
  return activeContainers.get(sessionId)?.spawnedAt ?? 0;
}

/**
 * In-flight wake promises, keyed by session id. Deduplicates concurrent
 * `wakeContainer` calls while the first spawn is still mid-setup (async
 * buildContainerArgs, OneCLI gateway apply, etc.) — otherwise a second
 * wake in that window passes the `activeContainers.has` check and spawns
 * a duplicate container against the same session directory, producing
 * racy double-replies.
 */
const wakePromises = new Map<string, Promise<boolean>>();

export function getActiveContainerCount(): number {
  return activeContainers.size;
}

export function isContainerRunning(sessionId: string): boolean {
  return activeContainers.has(sessionId);
}

/**
 * Wake up a container for a session. If already running or mid-spawn, no-op
 * (the in-flight wake promise is reused).
 *
 * The container runs the v2 agent-runner which polls the session DB.
 *
 * Contract: never throws. Returns `true` on successful spawn, `false` on
 * transient spawn failure (e.g. OneCLI gateway unreachable). Callers don't
 * need to wrap — the inbound row stays pending and host-sweep retries on
 * its next tick. Callers that care (e.g. the router's typing indicator)
 * can branch on the boolean.
 */
export function wakeContainer(session: Session): Promise<boolean> {
  if (activeContainers.has(session.id)) {
    log.debug('Container already running', { sessionId: session.id });
    return Promise.resolve(true);
  }
  const existing = wakePromises.get(session.id);
  if (existing) {
    log.debug('Container wake already in-flight — joining existing promise', { sessionId: session.id });
    return existing;
  }
  const activeCount = activeContainers.size;
  const inFlightWakes = wakePromises.size;
  if (MAX_CONCURRENT_CONTAINERS > 0 && activeCount + inFlightWakes >= MAX_CONCURRENT_CONTAINERS) {
    log.warn('Container wake deferred — concurrency cap reached', {
      sessionId: session.id,
      activeCount,
      inFlightWakes,
      maxConcurrentContainers: MAX_CONCURRENT_CONTAINERS,
    });
    return Promise.resolve(false);
  }
  const promise = spawnContainer(session)
    .then(() => true)
    .catch((err) => {
      log.warn('wakeContainer failed — host-sweep will retry', { sessionId: session.id, err });
      return false;
    })
    .finally(() => {
      wakePromises.delete(session.id);
    });
  wakePromises.set(session.id, promise);
  return promise;
}

async function spawnContainer(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    log.error('Agent group not found', { agentGroupId: session.agent_group_id });
    return;
  }

  // Refresh the destination map and default reply routing so any admin
  // changes take effect on wake. Destinations come from the agent-to-agent
  // module — skip when the module isn't installed (table absent).
  if (hasTable(getDb(), 'agent_destinations')) {
    const { writeDestinations } = await import('./modules/agent-to-agent/write-destinations.js');
    writeDestinations(agentGroup.id, session.id);
  }
  writeSessionRouting(agentGroup.id, session.id);

  // Snapshot host capabilities into the session dir so the container can
  // read a static JSON (Phase 5.3). Refreshed every spawn so newly-mounted
  // credentials / plugins / channel registrations appear immediately.
  writeCapabilitiesSnapshot(agentGroup.id, session.id);

  // Read container config once — threaded through provider resolution,
  // buildMounts, and buildContainerArgs so we don't re-read the file.
  const containerConfig = readContainerConfig(agentGroup.folder);

  // Ensure container.json has the agent group identity fields the runner needs.
  // Written at spawn time so the runner can read them from the RO mount.
  ensureRuntimeFields(containerConfig, agentGroup);

  // Resolve the effective provider + any host-side contribution it declares
  // (extra mounts, env passthrough). Computed once and threaded through both
  // buildMounts and buildContainerArgs so side effects (mkdir, etc.) fire once.
  const { provider, contribution } = resolveProviderContribution(session, agentGroup, containerConfig);

  const mounts = buildMounts(agentGroup, session, containerConfig, contribution);
  const containerName = `nanoclaw-v2-${agentGroup.folder}-${Date.now()}`;
  // OneCLI agent identifier is always the agent group id — stable across
  // sessions and reversible via getAgentGroup() for approval routing.
  const agentIdentifier = agentGroup.id;
  // Resolve per-channel (messaging_group_agents) default_model / default_effort
  // so buildContainerArgs can apply them ABOVE the per-agent container.json
  // defaults. Null/missing falls through. Agent-spawned sessions without a
  // messaging_group (e.g. pure agent-to-agent) skip this lookup.
  let channelDefaultModel: string | null = null;
  let channelDefaultEffort: string | null = null;
  let channelDefaultTone: string | null = null;
  if (session.messaging_group_id) {
    const { getMessagingGroupAgentByPair } = await import('./db/messaging-groups.js');
    const wiring = getMessagingGroupAgentByPair(session.messaging_group_id, agentGroup.id);
    if (wiring) {
      channelDefaultModel = wiring.default_model;
      channelDefaultEffort = wiring.default_effort;
      channelDefaultTone = wiring.default_tone;
    }
  }

  const args = await buildContainerArgs(
    mounts,
    containerName,
    agentGroup,
    containerConfig,
    provider,
    contribution,
    agentIdentifier,
    {
      channelDefaultModel,
      channelDefaultEffort,
      channelDefaultTone,
    },
  );

  log.info('Spawning container', { sessionId: session.id, agentGroup: agentGroup.name, containerName });

  // Clear any orphan heartbeat from a previous container instance — the
  // sweep's ceiling check treats a missing file as "fresh spawn, give grace"
  // (host-sweep.ts line 87). Without this, the stale mtime can trigger an
  // immediate kill before the new container touches the file itself.
  fs.rmSync(heartbeatPath(agentGroup.id, session.id), { force: true });

  const container = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  activeContainers.set(session.id, { process: container, containerName, spawnedAt: Date.now() });
  markContainerRunning(session.id);

  // Log stderr
  container.stderr?.on('data', (data) => {
    for (const line of data.toString().trim().split('\n')) {
      if (line) log.debug(line, { container: agentGroup.folder });
    }
  });

  // stdout is unused in v2 (all IO is via session DB)
  container.stdout?.on('data', () => {});

  // No host-side idle timeout. Stale/stuck detection is driven by the host
  // sweep reading heartbeat mtime + processing_ack claim age + container_state
  // (see src/host-sweep.ts). This avoids killing long-running legitimate work
  // on a wall-clock timer.

  container.on('close', (code) => {
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    log.info('Container exited', { sessionId: session.id, code, containerName });
  });

  container.on('error', (err) => {
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    log.error('Container spawn error', { sessionId: session.id, err });
  });
}

/** Kill a container for a session. */
export function killContainer(sessionId: string, reason: string): void {
  const entry = activeContainers.get(sessionId);
  if (!entry) return;

  log.info('Killing container', { sessionId, reason, containerName: entry.containerName });
  try {
    stopContainer(entry.containerName);
  } catch {
    entry.process.kill('SIGKILL');
  }
}

/**
 * Stop every active container synchronously at host shutdown.
 *
 * Load-bearing: without this, child container subprocesses linger in the
 * cgroup after the parent exits and systemd stalls for `TimeoutStopSec`
 * (default 90s) on every restart before SIGKILLing them. v1 wired this
 * into `GroupQueue.shutdown`; v2 lost it during the v1→v2 rewrite and the
 * host lingers similarly.
 *
 * Issues `docker stop` (SIGTERM then docker's own timeout → SIGKILL) to
 * every tracked container in parallel, waits for their close events up
 * to `gracePeriodMs`, then hard-kills anything still alive.
 */
export async function stopAllContainers(gracePeriodMs: number = 10_000): Promise<void> {
  const entries = Array.from(activeContainers.entries());
  if (entries.length === 0) return;
  log.info('Stopping all containers', { count: entries.length, gracePeriodMs });
  const exits = entries.map(([sessionId, entry]) => {
    const exited = new Promise<void>((resolve) => {
      if (entry.process.exitCode !== null) {
        resolve();
        return;
      }
      entry.process.once('close', () => resolve());
    });
    try {
      stopContainer(entry.containerName);
    } catch (err) {
      log.warn('stopContainer threw; falling back to SIGKILL', { sessionId, err });
      try {
        entry.process.kill('SIGKILL');
      } catch {
        // process already gone — ignore
      }
    }
    return exited;
  });
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timeoutHandle = setTimeout(resolve, gracePeriodMs);
  });
  await Promise.race([Promise.all(exits).then(() => undefined), timeout]);
  if (timeoutHandle) clearTimeout(timeoutHandle);
  // Hard-kill anything still tracked after the grace period.
  for (const [sessionId, entry] of activeContainers.entries()) {
    log.warn('Container did not exit within grace period; SIGKILL', {
      sessionId,
      containerName: entry.containerName,
    });
    try {
      entry.process.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
}

/**
 * Resolve a host env var value, folder-scoped.
 *
 * Lookup order:
 *   1. `<BASE>_<FOLDER_UPPER>` (dashes→underscores) — scoped variant
 *   2. `<BASE>` — unscoped default
 */
function resolveScopedEnv(baseName: string, folder: string): string | undefined {
  const conv = `${baseName}_${folder.toUpperCase().replace(/-/g, '_')}`;
  return process.env[conv] ?? process.env[baseName];
}

/**
 * Resolved Anthropic credentials for a single agent group. Forwarded
 * inside the container under their unscoped names so the agent-runner's
 * existing rotation regex (`/^CLAUDE_CODE_OAUTH_TOKEN_(\d+)$/`,
 * `/^ANTHROPIC_API_KEY_(\d+)$/`) matches verbatim.
 */
export interface ResolvedAnthropicAuth {
  oauthPrimary?: string;
  oauthFallbacks: { index: number; value: string }[];
  apiKeyPrimary?: string;
  apiKeyFallbacks: { index: number; value: string }[];
}

/**
 * Per-group Anthropic credentials. Default behaviour: every container
 * receives the global `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` (and
 * their `_N` rotation siblings). To pin a workplace account to a single
 * agent group, set `<BASE>_<FOLDER_UPPER>` (and optional rotation
 * siblings `<BASE>_<FOLDER_UPPER>_<N>`) in `.env` — when the per-group
 * primary is present, the *entire* rotation set comes from the per-group
 * variant and the global tokens are not forwarded. This prevents a
 * workplace account from ever falling back to a personal one (or vice
 * versa) on retryable errors.
 *
 * Folder names are uppercased and hyphens are normalised to underscores,
 * matching `resolveScopedEnv`. Folder names that match `^\d+$` collide
 * with the rotation suffix and per-group resolution is skipped for them.
 */
export function resolveAnthropicAuth(folder: string, env: NodeJS.ProcessEnv = process.env): ResolvedAnthropicAuth {
  const oauth = resolveScopedRotationSet('CLAUDE_CODE_OAUTH_TOKEN', folder, env);
  const apiKey = resolveScopedRotationSet('ANTHROPIC_API_KEY', folder, env);
  return {
    oauthPrimary: oauth.primary,
    oauthFallbacks: oauth.fallbacks,
    apiKeyPrimary: apiKey.primary,
    apiKeyFallbacks: apiKey.fallbacks,
  };
}

function resolveScopedRotationSet(
  base: string,
  folder: string,
  env: NodeJS.ProcessEnv,
): { primary?: string; fallbacks: { index: number; value: string }[] } {
  const folderTok = folder.toUpperCase().replace(/-/g, '_');
  const isPureDigits = /^\d+$/.test(folderTok);
  const scopedPrimaryKey = `${base}_${folderTok}`;
  const scopedPrimary = !isPureDigits ? env[scopedPrimaryKey] : undefined;

  if (scopedPrimary) {
    const fallbacks: { index: number; value: string }[] = [];
    const fallbackPrefix = `${scopedPrimaryKey}_`;
    for (const [k, v] of Object.entries(env)) {
      if (!v) continue;
      if (!k.startsWith(fallbackPrefix)) continue;
      const tail = k.slice(fallbackPrefix.length);
      if (!/^\d+$/.test(tail)) continue;
      fallbacks.push({ index: Number(tail), value: v });
    }
    fallbacks.sort((a, b) => a.index - b.index);
    return { primary: scopedPrimary, fallbacks };
  }

  const primary = env[base];
  const fallbacks: { index: number; value: string }[] = [];
  const fallbackRe = new RegExp(`^${base}_(\\d+)$`);
  for (const [k, v] of Object.entries(env)) {
    if (!v) continue;
    const m = k.match(fallbackRe);
    if (!m) continue;
    fallbacks.push({ index: Number(m[1]), value: v });
  }
  fallbacks.sort((a, b) => a.index - b.index);
  return { primary, fallbacks };
}

/**
 * Remove every `-e <key>=...` pair from args whose key matches. Used to
 * delete placeholder values OneCLI injects for credentials we plan to
 * substitute with the real value ourselves. Mutates args in place.
 */
function stripEnvEntry(args: string[], key: string): void {
  const prefix = `${key}=`;
  for (let i = args.length - 2; i >= 0; i--) {
    if (args[i] === '-e' && args[i + 1].startsWith(prefix)) {
      args.splice(i, 2);
    }
  }
}

/**
 * Append a host to the container's NO_PROXY / no_proxy env entries,
 * merging with any value OneCLI (or an earlier step) already set. Mutates
 * args in place. If neither form is present, adds both uppercase and
 * lowercase entries — Node respects uppercase, many Python/Go tools only
 * read lowercase.
 */
function mergeNoProxy(args: string[], host: string): void {
  const keys = ['NO_PROXY', 'no_proxy'];
  let touchedAny = false;
  for (const key of keys) {
    const prefix = `${key}=`;
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] !== '-e' || !args[i + 1].startsWith(prefix)) continue;
      const existing = args[i + 1].slice(prefix.length);
      const parts = existing
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (!parts.includes(host)) parts.push(host);
      args[i + 1] = `${key}=${parts.join(',')}`;
      touchedAny = true;
    }
  }
  if (!touchedAny) {
    args.push('-e', `NO_PROXY=${host}`);
    args.push('-e', `no_proxy=${host}`);
  }
}

/**
 * Phase 5.3: write a capabilities snapshot into the session dir at
 * every container spawn. Container's get_capabilities MCP tool reads
 * this JSON directly — no round-trip, always fresh per spawn.
 */
function writeCapabilitiesSnapshot(agentGroupId: string, sessionId: string): void {
  try {
    const caps = getHostCapabilities(agentGroupId);
    const outPath = path.join(sessionDir(agentGroupId, sessionId), 'capabilities.json');
    fs.writeFileSync(outPath, JSON.stringify(caps, null, 2) + '\n');
  } catch (err) {
    log.warn('Failed to write capabilities snapshot', { err });
  }
}

function resolveGitHubToken(folder: string, cfg: ContainerConfig): string | undefined {
  if (cfg.githubTokenEnv) {
    const v = process.env[cfg.githubTokenEnv];
    if (v) return v;
  }
  return resolveScopedEnv('GITHUB_TOKEN', folder);
}

/**
 * Credential env vars auto-forwarded per agent group via <NAME>_<FOLDER>
 * → <NAME> resolution. Non-sensitive tool-config vars belong in the image
 * or container.json — this list is for things whose *value* differs per
 * group.
 */
const SCOPED_CREDENTIAL_VARS = [
  'RENDER_API_KEY',
  'RENDER_WORKSPACE_ID',
  'SNOWFLAKE_ACCOUNT',
  'SNOWFLAKE_USER',
  'SNOWFLAKE_PASSWORD',
  'SNOWFLAKE_WAREHOUSE',
  'SNOWFLAKE_ROLE',
  'SNOWFLAKE_DATABASE',
  'DBT_CLOUD_ACCOUNT_ID',
  'DBT_CLOUD_API_TOKEN',
  // dbt Cloud email/password login path — v1 carried these; skills that
  // use the email+password flow (not just Account-ID/API-Token) need them.
  'DBT_CLOUD_EMAIL',
  'DBT_CLOUD_PASSWORD',
  'DBT_CLOUD_API_URL',
  // dbt-mcp (dbt-labs/dbt-mcp) — Discovery + Semantic Layer + Admin API.
  // Token reuses DBT_CLOUD_API_TOKEN; these are the additional vars dbt-mcp
  // requires that the raw REST flow does not.
  'DBT_HOST',
  'DBT_MULTICELL_ACCOUNT_PREFIX',
  'DBT_PROD_ENV_ID',
  'DBT_DEV_ENV_ID',
  'DBT_USER_ID',
  'DBT_MCP_DISABLE_TOOLS',
  'OPENAI_API_KEY',
  'BRAINTRUST_API_KEY',
  'EXA_API_KEY',
  'DEEPGRAM_API_KEY',
  'ELEVENLABS_API_KEY',
  'RESIDENTIAL_PROXY_URL',
  // Omni API — required by the omni skill; absent → first call fails 401.
  'OMNI_BASE_URL',
  'OMNI_API_KEY',
  // Railway CLI / API — `railway login` uses this token; absent → CLI hangs
  // on interactive auth inside the container.
  'RAILWAY_API_TOKEN',
  // Browser-auth skill (Playwright geo-fenced login flows) — absent → login
  // form can't be filled and the skill times out on the first call.
  'BROWSER_AUTH_URL',
  'BROWSER_AUTH_EMAIL',
  'BROWSER_AUTH_PASSWORD',
  // Supabase CLI: project ref + DB password for `supabase link`, access token
  // for management API (`supabase projects list`, etc.).
  'SUPABASE_PROJECT_REF',
  'SUPABASE_ACCESS_TOKEN',
  'SUPABASE_DB_PASSWORD',
  // Git commit identity. Env vars take precedence over `git -c user.name=...`
  // overrides used by the in-container git_commit MCP tool, so setting these
  // per-group attributes commits to the human, not "agent".
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
];

/**
 * Resolve the provider name for a session using the precedence documented in
 * the provider-install skills:
 *
 *   sessions.agent_provider
 *     → agent_groups.agent_provider
 *     → container.json `provider`
 *     → 'claude'
 *
 * Pure so the precedence can be unit-tested without a DB or filesystem.
 */
export function resolveProviderName(
  sessionProvider: string | null | undefined,
  agentGroupProvider: string | null | undefined,
  containerConfigProvider: string | null | undefined,
): string {
  return (sessionProvider || agentGroupProvider || containerConfigProvider || 'claude').toLowerCase();
}

function resolveProviderContribution(
  session: Session,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
): { provider: string; contribution: ProviderContainerContribution } {
  const provider = resolveProviderName(session.agent_provider, agentGroup.agent_provider, containerConfig.provider);
  const fn = getProviderContainerConfig(provider);
  const contribution = fn
    ? fn({
        sessionDir: sessionDir(agentGroup.id, session.id),
        agentGroupId: agentGroup.id,
        hostEnv: process.env,
      })
    : {};
  return { provider, contribution };
}

function buildMounts(
  agentGroup: AgentGroup,
  session: Session,
  containerConfig: import('./container-config.js').ContainerConfig,
  providerContribution: ProviderContainerContribution,
): VolumeMount[] {
  const projectRoot = process.cwd();

  // Per-group filesystem state lives forever after first creation. Init is
  // idempotent: it only writes paths that don't already exist, so this call
  // is a no-op for groups that have spawned before.
  initGroupFilesystem(agentGroup);

  // Sync skill symlinks based on container.json selection before mounting.
  const claudeDir = path.join(DATA_DIR, 'v2-sessions', agentGroup.id, '.claude-shared');
  syncSkillSymlinks(claudeDir, containerConfig);

  // Compose CLAUDE.md fresh every spawn from the shared base, enabled skill
  // fragments, and MCP server instructions. See `claude-md-compose.ts`.
  composeGroupClaudeMd(agentGroup);

  const mounts: VolumeMount[] = [];
  const sessDir = sessionDir(agentGroup.id, session.id);
  const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);

  // Session folder at /workspace (contains inbound.db, outbound.db, outbox/, .claude/).
  //
  // The session dir parent is mounted RW because the container legitimately
  // writes: outbound.db (its own), outbox/<id>/ (file deliveries), and
  // .heartbeat (liveness touch).
  //
  // inbound.db, however, is host-owned and MUST be unwritable from the
  // container. Without this, a compromised agent could forge admin
  // approvals by directly INSERT-ing into the `delivered` table, trivially
  // bypassing the email-gate, send_file ack, and any future host→container
  // signaling that rides on inbound.db. The file-level RO overlay below
  // reuses the same host file; Docker applies mount rules in order, so the
  // `:ro` on inbound.db overrides the parent mount's RW permission for
  // that specific path.
  //
  // The SDK-level `readonly: true` open in container/agent-runner/src/db/
  // connection.ts is belt and suspenders. The mount is the real boundary.
  mounts.push({ hostPath: sessDir, containerPath: '/workspace', readonly: false });
  const inboundDbFile = path.join(sessDir, 'inbound.db');
  if (fs.existsSync(inboundDbFile)) {
    mounts.push({ hostPath: inboundDbFile, containerPath: '/workspace/inbound.db', readonly: true });
  }

  // Channel-root inbound.db at /workspace/channel-inbound.db (read-only).
  // Scheduled tasks live in the channel-root session for this (agent, MG)
  // pair, not in the calling thread's session. The container's `list_tasks`
  // MCP tool reads from this mount so any thread can list/inspect tasks
  // scoped to the channel. Writes still go through the host system-action
  // path, which routes to the same channel-root inbound.db.
  //
  // Always mount when a channel-root session exists, including when the
  // current session IS the channel-root — duplicate bind-mount of the same
  // file is harmless and keeps `getChannelInboundDb()` uniform.
  if (session.messaging_group_id) {
    const channelSession = findSessionByAgentGroupAndMessagingGroup(agentGroup.id, session.messaging_group_id);
    if (channelSession) {
      const channelInboundFile = path.join(sessionDir(agentGroup.id, channelSession.id), 'inbound.db');
      if (fs.existsSync(channelInboundFile)) {
        mounts.push({
          hostPath: channelInboundFile,
          containerPath: '/workspace/channel-inbound.db',
          readonly: true,
        });
      }
    }
  }

  // Agent group folder at /workspace/agent (RW for working files + CLAUDE.local.md)
  mounts.push({ hostPath: groupDir, containerPath: '/workspace/agent', readonly: false });

  // container.json — nested RO mount on top of RW group dir so the agent
  // can read its config but cannot modify it.
  const containerJsonPath = path.join(groupDir, 'container.json');
  if (fs.existsSync(containerJsonPath)) {
    mounts.push({ hostPath: containerJsonPath, containerPath: '/workspace/agent/container.json', readonly: true });
  }

  // Composer-managed CLAUDE.md artifacts — nested RO mounts. These are
  // regenerated from the shared base + fragments on every spawn; any
  // agent-side writes would be clobbered, so enforce read-only. Only
  // CLAUDE.local.md (per-group memory) remains RW via the group-dir mount.
  // `.claude-shared.md` is a symlink whose target (`/app/CLAUDE.md`) is
  // already RO-mounted, so writes through it fail regardless — no need for
  // a nested mount there.
  const composedClaudeMd = path.join(groupDir, 'CLAUDE.md');
  if (fs.existsSync(composedClaudeMd)) {
    mounts.push({ hostPath: composedClaudeMd, containerPath: '/workspace/agent/CLAUDE.md', readonly: true });
  }
  const fragmentsDir = path.join(groupDir, '.claude-fragments');
  if (fs.existsSync(fragmentsDir)) {
    mounts.push({ hostPath: fragmentsDir, containerPath: '/workspace/agent/.claude-fragments', readonly: true });
  }

  // Global memory directory — always read-only.
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    mounts.push({ hostPath: globalDir, containerPath: '/workspace/global', readonly: true });
  }

  // .claude mount triple (group-shared parent + per-session projects overlay
  // + group-shared memory overlay). See session-claude-mounts.ts for the
  // ordering invariant and the race it prevents.
  mounts.push(...getSessionClaudeMounts(agentGroup, session));

  // Shared CLAUDE.md — read-only, imported by the composed entry point via
  // the `.claude-shared.md` symlink inside the group dir.
  const sharedClaudeMd = path.join(process.cwd(), 'container', 'CLAUDE.md');
  if (fs.existsSync(sharedClaudeMd)) {
    mounts.push({ hostPath: sharedClaudeMd, containerPath: '/app/CLAUDE.md', readonly: true });
  }

  // Per-agent archive + central projections (NOT the global files).
  //
  // Mounting the global archive.db / v2.db cross-exposed every tenant's
  // chat history and topology to every container — the container has shell +
  // raw SQLite access at /workspace, so MCP filter-by-agent_group_id was
  // advisory-only. A compromised agent could `sqlite3 /workspace/archive.db
  // 'SELECT text FROM messages_archive WHERE agent_group_id = X'` for any X.
  //
  // Each container now gets a freshly-built projection containing ONLY rows
  // for its own agent_group_id, regenerated on every spawn at
  // data/v2-sessions/<ag>/<sess>/{archive,central}.db.
  const archiveSrc = path.join(DATA_DIR, 'archive.db');
  const archiveDst = path.join(sessionDir(agentGroup.id, session.id), 'archive.db');
  buildArchiveProjection(archiveSrc, archiveDst, agentGroup.id);
  mounts.push({ hostPath: archiveDst, containerPath: '/workspace/archive.db', readonly: true });

  const centralSrc = path.join(DATA_DIR, 'v2.db');
  const centralDst = path.join(sessionDir(agentGroup.id, session.id), 'central.db');
  buildCentralProjection(centralSrc, centralDst, agentGroup.id);
  mounts.push({ hostPath: centralDst, containerPath: '/workspace/central.db', readonly: true });

  // Shared agent-runner source — read-only, same code for all groups.
  const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
  mounts.push({ hostPath: agentRunnerSrc, containerPath: '/app/src', readonly: true });

  // Shared skills — read-only, symlinks in .claude-shared/skills/ point here.
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  if (fs.existsSync(skillsSrc)) {
    mounts.push({ hostPath: skillsSrc, containerPath: '/app/skills', readonly: true });
  }

  // Additional mounts from container config
  if (containerConfig.additionalMounts && containerConfig.additionalMounts.length > 0) {
    const validated = validateAdditionalMounts(containerConfig.additionalMounts, agentGroup.name);
    mounts.push(...validated);
  }

  // Memory store: per-group RW mount so sqlite can create journal/lock files.
  // Scoped to agentGroupId (C20 cross-tenant narrowing — never mount whole ~/.mnemon/).
  if (containerConfig.memory?.enabled === true) {
    const mnemonDataDir = path.join(os.homedir(), '.mnemon', 'data', agentGroup.id);
    fs.mkdirSync(mnemonDataDir, { recursive: true });
    mounts.push({
      hostPath: mnemonDataDir,
      containerPath: `/home/node/.mnemon/data/${agentGroup.id}`,
      readonly: false,
    });
  }

  // Built-in nanoclaw-hooks plugin: project-relative, always mounted.
  // Provides the GitNexus repo-readiness guard (PreToolUse) and the
  // post-commit blast-radius verification hook (PostToolUse). Unlike
  // external plugins, this one ships with NanoClaw itself. Same
  // discovery path (CLAUDE_PLUGINS_ROOT → /workspace/plugins/*).
  const builtinPlugin = path.resolve(GROUPS_DIR, '..', 'container', 'nanoclaw-plugin');
  if (fs.existsSync(builtinPlugin)) {
    mounts.push({
      hostPath: builtinPlugin,
      containerPath: '/workspace/plugins/nanoclaw-hooks',
      readonly: true,
    });
  }

  // Plugin mounts: every subdir of ~/plugins is mounted RO at
  // /workspace/plugins/<name>. Claude Code SDK auto-discovers via
  // CLAUDE_PLUGINS_ROOT (set in buildContainerArgs). Per-group
  // excludePlugins deny list skips named plugins — useful for limiting
  // a group's tool surface (e.g. security agents without codex).
  //
  // Special case: if codex plugin is mounted and the host's ~/.codex dir
  // exists, mount that RW so the Codex CLI can use the host's OAuth
  // session and persist refresh tokens.
  const pluginsHostDir = path.join(os.homedir(), 'plugins');
  if (fs.existsSync(pluginsHostDir)) {
    const excluded = new Set(containerConfig.excludePlugins ?? []);
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(pluginsHostDir);
    } catch (err) {
      log.warn('Failed to read ~/plugins directory', { err });
    }
    for (const entry of entries) {
      if (excluded.has(entry)) continue;
      const pluginHostPath = path.join(pluginsHostDir, entry);
      try {
        if (!fs.statSync(pluginHostPath).isDirectory()) continue;
      } catch {
        continue;
      }
      mounts.push({
        hostPath: pluginHostPath,
        containerPath: `/workspace/plugins/${entry}`,
        readonly: true,
      });
    }

    // Host ~/.codex mount: opt-in via container.json `codexHostAuth: true`.
    // RW because the Codex CLI rewrites auth.json on token refresh — RO
    // breaks long-running sessions when access tokens expire. Token-theft
    // risk is unchanged regardless of RO/RW (read access alone is enough),
    // so the security improvement is the OPT-IN itself: pre-2026-05-03 the
    // mount fired on every group that had the codex plugin available;
    // now operators must explicitly grant Codex host auth per group.
    if (containerConfig.codexHostAuth === true && !excluded.has('codex') && entries.includes('codex')) {
      const providerHasCodexMount = providerContribution.mounts?.some((m) => m.containerPath === '/home/node/.codex');
      if (!providerHasCodexMount) {
        const hostCodex = path.join(os.homedir(), '.codex');
        if (fs.existsSync(hostCodex)) {
          mounts.push({ hostPath: hostCodex, containerPath: '/home/node/.codex', readonly: false });
        }
      }
    }
  }

  // Project source tree at /workspace/project (RO). Lets agents read the
  // NanoClaw codebase — useful for self-diagnostic questions ("why did
  // you do X?"), self-mod context, and understanding their own runtime.
  // We mount a selective allowlist rather than the whole project root
  // to exclude .env, data/, groups/, repo-tokens/, node_modules/, dist/,
  // logs/, and other sensitive or bulky paths.
  //
  // scripts/ and prompts/ are INTENTIONALLY excluded: v1 commit 3a31f9d
  // removed them from the allowlist after noting that scripts/ exposes
  // credential path topology (wire-*, migrate-*, init-* scripts reference
  // host paths) and prompts/ was unused agent-facing content. Keep them
  // out unless there's a specific capability that needs them and a clear
  // review of what's in them.
  // projectRoot (declared at top of buildMounts) is equivalent to
  // path.resolve(GROUPS_DIR, '..') since GROUPS_DIR is <projectRoot>/groups.
  const sourceEntries = [
    'src',
    'container',
    'docs',
    'package.json',
    'README.md',
    'CONTRIBUTING.md',
    'CLAUDE.md',
    'AGENTS.md',
    'tsconfig.json',
  ];
  for (const entry of sourceEntries) {
    const hostEntry = path.join(projectRoot, entry);
    if (fs.existsSync(hostEntry)) {
      mounts.push({
        hostPath: hostEntry,
        containerPath: `/workspace/project/${entry}`,
        readonly: true,
      });
    }
  }

  // Tone profiles — project-relative, shared across all groups. Read-only:
  // groups select a profile in their CLAUDE.md; the files themselves are
  // managed via the /add-tone-profile skill on the host.
  const toneProfilesDir = path.resolve(GROUPS_DIR, '..', 'tone-profiles');
  if (fs.existsSync(toneProfilesDir)) {
    mounts.push({
      hostPath: toneProfilesDir,
      containerPath: '/workspace/tone-profiles',
      readonly: true,
    });
  }

  // Host-side credential dirs — gated by the per-agent `tools` allowlist in
  // container.json. Two modes:
  //
  //   tools = undefined  → legacy behavior, mount every credential surface.
  //                        Preserves the pre-v2-tools-port default.
  //   tools = [...]      → filter + stage per-tool. E.g. `snowflake:sunday`
  //                        stages only the [connections.sunday] section of
  //                        connections.toml and its referenced private
  //                        keys; `aws:work` stages [default] + [work] from
  //                        ~/.aws/credentials; `dbt:snowflake-db` stages a
  //                        profiles.yml containing only that profile.
  //
  // Rationale for the gate (see docs/V2_BACKLOG.md → scoped credentials):
  //   OneCLI's proxy covers API-level secrets (keys flowing through
  //   HTTPS_PROXY). Filesystem credentials — private keys, INI/TOML with
  //   raw passwords, service-account JSONs — are *not* OneCLI-mediated.
  //   Without per-agent scoping every agent can `cat` every other agent's
  //   creds. v1 enforced this at mount time; v2 now does too when `tools`
  //   is set.
  const home = os.homedir();
  const tools = containerConfig.tools;
  const stagingRoot = path.join(sessDir, 'creds');

  // Prepare a clean per-cred staging subdir. Caller passes the dir name;
  // returns the absolute path. We rm+mkdir to avoid stale files leaking
  // between spawns of the same session (e.g. after an agent re-scope).
  const stageDir = (name: string): string => {
    const p = path.join(stagingRoot, name);
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true });
    fs.mkdirSync(p, { recursive: true });
    return p;
  };

  const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // ---- Gmail MCP (legacy per-account dirs) --------------------------------
  if (isToolEnabled(tools, 'gmail') || isToolEnabled(tools, 'gmail-readonly')) {
    const g = extractToolScopes(tools, 'gmail');
    const r = extractToolScopes(tools, 'gmail-readonly');
    const scopedAccounts = [...new Set([...g.scopes, ...r.scopes])];
    const anyScoped = scopedAccounts.length > 0 && !tools?.includes('gmail');

    if (anyScoped) {
      // First scoped account gets the primary path; extras mounted at named paths.
      const primary = scopedAccounts[0];
      const primaryDir = path.join(home, `.gmail-mcp-${primary}`);
      if (fs.existsSync(primaryDir)) {
        mounts.push({ hostPath: primaryDir, containerPath: '/home/node/.gmail-mcp', readonly: true });
      }
      for (let i = 1; i < scopedAccounts.length; i++) {
        const acctDir = path.join(home, `.gmail-mcp-${scopedAccounts[i]}`);
        if (fs.existsSync(acctDir)) {
          mounts.push({
            hostPath: acctDir,
            containerPath: `/home/node/.gmail-mcp-${scopedAccounts[i]}`,
            readonly: true,
          });
        }
      }
    } else {
      // Unscoped (or tools undefined): mount primary + every .gmail-mcp-*/
      const primaryDir = path.join(home, '.gmail-mcp');
      if (fs.existsSync(primaryDir)) {
        mounts.push({ hostPath: primaryDir, containerPath: '/home/node/.gmail-mcp', readonly: true });
      }
      try {
        for (const entry of fs.readdirSync(home)) {
          if (!entry.startsWith('.gmail-mcp-')) continue;
          const dir = path.join(home, entry);
          try {
            if (!fs.statSync(dir).isDirectory()) continue;
          } catch {
            continue;
          }
          mounts.push({ hostPath: dir, containerPath: `/home/node/${entry}`, readonly: true });
        }
      } catch {
        // home may not be readable — skip
      }
    }
  }

  // ---- Google Calendar MCP ------------------------------------------------
  if (isToolEnabled(tools, 'calendar')) {
    const calDir = path.join(home, '.config', 'google-calendar-mcp');
    const { scopes: calAccts, isScoped: calScoped } = extractToolScopes(tools, 'calendar');
    if (fs.existsSync(calDir)) {
      if (calScoped) {
        // Filter tokens.json to allowed accounts; fail CLOSED on parse error
        // (do NOT fall back to the full dir — that defeats the scope).
        const tokensPath = path.join(calDir, 'tokens.json');
        if (fs.existsSync(tokensPath)) {
          try {
            const all = JSON.parse(fs.readFileSync(tokensPath, 'utf-8')) as Record<string, unknown>;
            const filtered: Record<string, unknown> = {};
            for (const a of calAccts) if (all[a]) filtered[a] = all[a];
            const dest = stageDir('google-calendar-mcp');
            fs.writeFileSync(path.join(dest, 'tokens.json'), JSON.stringify(filtered, null, 2), { mode: 0o600 });
            // Copy non-token files (settings etc.) as-is.
            for (const entry of fs.readdirSync(calDir)) {
              if (entry === 'tokens.json') continue;
              const src = path.join(calDir, entry);
              try {
                if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(dest, entry));
              } catch {
                continue;
              }
            }
            mounts.push({
              hostPath: dest,
              containerPath: '/home/node/.config/google-calendar-mcp',
              readonly: true,
            });
          } catch (err) {
            log.warn('Calendar tokens filter failed — skipping mount (fail closed)', {
              agent: agentGroup.folder,
              err: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } else {
        mounts.push({ hostPath: calDir, containerPath: '/home/node/.config/google-calendar-mcp', readonly: true });
      }
    }

    // Calendar reuses the Gmail OAuth app keys. If gmail isn't enabled for
    // this agent, mount JUST the keys file (not the full gmail dir, which
    // would leak Gmail tokens to a calendar-only scope).
    if (!isToolEnabled(tools, 'gmail')) {
      const oauthKeys = path.join(home, '.gmail-mcp', 'gcp-oauth.keys.json');
      if (fs.existsSync(oauthKeys)) {
        mounts.push({
          hostPath: oauthKeys,
          containerPath: '/home/node/.gmail-mcp/gcp-oauth.keys.json',
          readonly: true,
        });
      }
    }
  }

  // ---- Google Workspace (gws-style accounts dir) --------------------------
  if (isToolEnabled(tools, 'google-workspace')) {
    const gwsAccountsDir = path.join(home, '.config', 'gws', 'accounts');
    if (fs.existsSync(gwsAccountsDir)) {
      const { scopes: gwsAccts, isScoped: gwsScoped } = extractToolScopes(tools, 'google-workspace');
      if (gwsScoped) {
        // Each account has its own JSON file under accounts/. Stage only
        // the allowed ones. Entries can be files (<acct>.json) or dirs.
        const dest = stageDir('gws-accounts');
        for (const acct of gwsAccts) {
          const fileCandidate = path.join(gwsAccountsDir, `${acct}.json`);
          const dirCandidate = path.join(gwsAccountsDir, acct);
          try {
            if (fs.existsSync(fileCandidate) && fs.statSync(fileCandidate).isFile()) {
              fs.copyFileSync(fileCandidate, path.join(dest, `${acct}.json`));
              fs.chmodSync(path.join(dest, `${acct}.json`), 0o600);
            } else if (fs.existsSync(dirCandidate) && fs.statSync(dirCandidate).isDirectory()) {
              fs.cpSync(dirCandidate, path.join(dest, acct), { recursive: true });
            } else {
              log.warn('google-workspace account not found in gws dir', { acct, agent: agentGroup.folder });
            }
          } catch (err) {
            log.warn('google-workspace scoped copy failed', {
              acct,
              err: err instanceof Error ? err.message : String(err),
            });
          }
        }
        mounts.push({ hostPath: dest, containerPath: '/home/node/.config/gws/accounts', readonly: true });
      } else {
        mounts.push({ hostPath: gwsAccountsDir, containerPath: '/home/node/.config/gws/accounts', readonly: true });
      }
    }

    // Legacy google_workspace_mcp/credentials/ — same pattern.
    const gwCredsDir = path.join(home, '.google_workspace_mcp', 'credentials');
    if (fs.existsSync(gwCredsDir)) {
      const { scopes: gwAccts, isScoped: gwScoped } = extractToolScopes(tools, 'google-workspace');
      if (gwScoped) {
        const dest = stageDir('google-workspace-mcp-credentials');
        for (const entry of fs.readdirSync(gwCredsDir)) {
          // match entries that START with an allowed account name (allows
          // <acct>.json, <acct>_token.json, etc. — v1 pattern).
          if (!gwAccts.some((a) => entry.startsWith(a))) continue;
          const src = path.join(gwCredsDir, entry);
          try {
            if (fs.statSync(src).isFile()) {
              fs.copyFileSync(src, path.join(dest, entry));
              fs.chmodSync(path.join(dest, entry), 0o600);
            }
          } catch {
            continue;
          }
        }
        mounts.push({
          hostPath: dest,
          containerPath: '/home/node/.google_workspace_mcp/credentials',
          readonly: true,
        });
      } else {
        mounts.push({
          hostPath: gwCredsDir,
          containerPath: '/home/node/.google_workspace_mcp/credentials',
          readonly: true,
        });
      }
    }
  }

  // ---- Snowflake (connections.toml + keys) --------------------------------
  if (isToolEnabled(tools, 'snowflake')) {
    const snowflakeDir = path.join(home, '.snowflake');
    const origToml = path.join(snowflakeDir, 'connections.toml');
    if (fs.existsSync(snowflakeDir) && fs.existsSync(origToml)) {
      const { scopes: allowedConns, isScoped: filterConns } = extractToolScopes(tools, 'snowflake');
      const dest = stageDir('snowflake');

      // Rewrite host paths → /home/node paths so in-container CLIs find
      // their own keys. snowflake-connector-python historically doesn't
      // expand `~`, so we normalize to absolute /home/node/... paths.
      const homePattern = new RegExp(escapeRegex(snowflakeDir) + '/', 'g');
      let tomlContent = fs.readFileSync(origToml, 'utf-8').replace(homePattern, '/home/node/.snowflake/');
      if (filterConns) tomlContent = filterConfigSections(tomlContent, allowedConns);
      fs.writeFileSync(path.join(dest, 'connections.toml'), tomlContent, { mode: 0o600 });

      const origConfig = path.join(snowflakeDir, 'config.toml');
      if (fs.existsSync(origConfig)) {
        const configContent = fs.readFileSync(origConfig, 'utf-8').replace(homePattern, '/home/node/.snowflake/');
        fs.writeFileSync(path.join(dest, 'config.toml'), configContent, { mode: 0o600 });
      }

      // Copy only key files that the (possibly filtered) toml actually
      // references — never the whole keys/ dir under scoping.
      const keysDir = path.join(snowflakeDir, 'keys');
      if (fs.existsSync(keysDir)) {
        const referenced = new Set<string>();
        for (const m of tomlContent.matchAll(/private_key_path\s*=\s*"[^"]*\/keys\/([^"]+)"/g)) {
          referenced.add(m[1]);
        }
        const destKeys = path.join(dest, 'keys');
        fs.mkdirSync(destKeys, { recursive: true });
        for (const entry of fs.readdirSync(keysDir, { withFileTypes: true, recursive: true })) {
          if (!entry.isFile()) continue;
          const srcPath = path.join(entry.parentPath, entry.name);
          const relPath = path.relative(keysDir, srcPath);
          // When filtering, skip any key not referenced by allowed conns.
          // When not filtering, copy everything.
          if (filterConns && referenced.size > 0 && !referenced.has(relPath)) continue;
          const destPath = path.join(destKeys, relPath);
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          fs.copyFileSync(srcPath, destPath);
          fs.chmodSync(destPath, 0o600);
        }
      }

      // Mount RW: snow CLI writes to ~/.snowflake/logs/.
      mounts.push({ hostPath: dest, containerPath: '/home/node/.snowflake', readonly: false });

      // Dual-mount at host absolute path too — some snowflake libs record
      // the originally-resolved absolute path in session state and retry
      // reads at that path. The container sees the same staging dir.
      if (snowflakeDir !== '/home/node/.snowflake') {
        mounts.push({ hostPath: dest, containerPath: snowflakeDir, readonly: false });
      }
    }
  }

  // ---- AWS (~/.aws/{credentials,config}) ----------------------------------
  if (isToolEnabled(tools, 'aws')) {
    const awsDir = path.join(home, '.aws');
    if (fs.existsSync(awsDir)) {
      const { scopes: allowedProfiles, isScoped: filterProfiles } = extractToolScopes(tools, 'aws');
      const dest = stageDir('aws');
      const alwaysInclude = new Set(['default']);

      const origCreds = path.join(awsDir, 'credentials');
      if (fs.existsSync(origCreds)) {
        let content = fs.readFileSync(origCreds, 'utf-8');
        if (filterProfiles) content = filterConfigSections(content, allowedProfiles, { alwaysInclude });
        fs.writeFileSync(path.join(dest, 'credentials'), content, { mode: 0o600 });
      }
      const origConfig = path.join(awsDir, 'config');
      if (fs.existsSync(origConfig)) {
        let content = fs.readFileSync(origConfig, 'utf-8');
        if (filterProfiles) {
          // AWS config uses `[profile foo]` rather than `[foo]` — transform
          // to compare raw name against the allowlist.
          content = filterConfigSections(content, allowedProfiles, {
            headerTransform: (h) => h.replace(/^profile\s+/, ''),
            alwaysInclude,
          });
        }
        fs.writeFileSync(path.join(dest, 'config'), content, { mode: 0o600 });
      }
      mounts.push({ hostPath: dest, containerPath: '/home/node/.aws', readonly: true });
    }
  }

  // ---- gcloud (~/.gcloud-keys/*.json) -------------------------------------
  if (isToolEnabled(tools, 'gcloud')) {
    const gcloudKeysDir = path.join(home, '.gcloud-keys');
    if (fs.existsSync(gcloudKeysDir)) {
      const { scopes: gcloudScopes, isScoped: gcloudScoped } = extractToolScopes(tools, 'gcloud');
      const dest = stageDir('gcloud-keys');

      if (gcloudScoped) {
        // v1 convention: GCLOUD_KEY_<SCOPE>=<filename.json> env var in the
        // host process env maps scope → key file. Keep the same contract.
        for (const s of gcloudScopes) {
          const envKey = `GCLOUD_KEY_${s.toUpperCase()}`;
          const keyFile = process.env[envKey];
          if (!keyFile) {
            log.warn('gcloud scope has no GCLOUD_KEY_<SCOPE> mapping in env', { scope: s, envKey });
            continue;
          }
          const srcPath = path.join(gcloudKeysDir, keyFile);
          if (!fs.existsSync(srcPath)) {
            log.warn('gcloud key file not found', { srcPath, scope: s });
            continue;
          }
          const destPath = path.join(dest, keyFile);
          fs.copyFileSync(srcPath, destPath);
          fs.chmodSync(destPath, 0o600);
        }
      } else {
        // Unscoped: copy every .json under the keys dir.
        for (const entry of fs.readdirSync(gcloudKeysDir)) {
          if (!entry.endsWith('.json')) continue;
          const srcPath = path.join(gcloudKeysDir, entry);
          try {
            if (fs.statSync(srcPath).isFile()) {
              const destPath = path.join(dest, entry);
              fs.copyFileSync(srcPath, destPath);
              fs.chmodSync(destPath, 0o600);
            }
          } catch {
            continue;
          }
        }
      }
      mounts.push({ hostPath: dest, containerPath: '/home/node/.gcloud-keys', readonly: true });
    }
  }

  // ---- dbt (~/.dbt/profiles.yml) ------------------------------------------
  if (isToolEnabled(tools, 'dbt')) {
    const dbtDir = path.join(home, '.dbt');
    const origProfiles = path.join(dbtDir, 'profiles.yml');
    if (fs.existsSync(origProfiles)) {
      const { scopes, isScoped } = extractToolScopes(tools, 'dbt');
      const dest = stageDir('dbt');
      try {
        let profiles = YAML.parse(fs.readFileSync(origProfiles, 'utf-8')) as Record<string, unknown>;
        if (isScoped) {
          const filtered: Record<string, unknown> = {};
          for (const name of scopes) {
            if (profiles[name] !== undefined) filtered[name] = profiles[name];
          }
          profiles = filtered;
        }
        fs.writeFileSync(path.join(dest, 'profiles.yml'), YAML.stringify(profiles), { mode: 0o600 });
        mounts.push({ hostPath: dest, containerPath: '/home/node/.dbt', readonly: true });
      } catch (err) {
        log.warn('dbt profiles stage failed — skipping mount (fail closed)', {
          agent: agentGroup.folder,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Provider-contributed mounts (e.g. opencode-xdg)
  if (providerContribution.mounts) {
    mounts.push(...providerContribution.mounts);
  }

  return mounts;
}

/**
 * Sync skill symlinks in .claude-shared/skills/ to match the container.json
 * selection. Each symlink points to a container path (/app/skills/<name>)
 * so it's dangling on the host but valid inside the container.
 */
function syncSkillSymlinks(claudeDir: string, containerConfig: import('./container-config.js').ContainerConfig): void {
  const skillsDir = path.join(claudeDir, 'skills');
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  // Determine desired skill set
  const projectRoot = process.cwd();
  const sharedSkillsDir = path.join(projectRoot, 'container', 'skills');
  let desired: string[];
  if (containerConfig.skills === 'all') {
    // Recompute from shared dir — newly-added upstream skills appear automatically
    desired = fs.existsSync(sharedSkillsDir)
      ? fs.readdirSync(sharedSkillsDir).filter((e) => {
          try {
            return fs.statSync(path.join(sharedSkillsDir, e)).isDirectory();
          } catch {
            return false;
          }
        })
      : [];
  } else {
    desired = containerConfig.skills;
  }

  const desiredSet = new Set(desired);

  // Remove symlinks not in the desired set
  for (const entry of fs.readdirSync(skillsDir)) {
    const entryPath = path.join(skillsDir, entry);
    let isSymlink = false;
    try {
      isSymlink = fs.lstatSync(entryPath).isSymbolicLink();
    } catch {
      continue;
    }
    if (isSymlink && !desiredSet.has(entry)) {
      fs.unlinkSync(entryPath);
    }
  }

  // Create symlinks for desired skills (container path targets)
  for (const skill of desired) {
    const linkPath = path.join(skillsDir, skill);
    let exists = false;
    try {
      fs.lstatSync(linkPath);
      exists = true;
    } catch {
      /* missing */
    }
    if (!exists) {
      fs.symlinkSync(`/app/skills/${skill}`, linkPath);
    }
  }
}

/**
 * Ensure container.json has the runtime identity fields the runner needs.
 * Written at spawn time so they're always current even if the DB values
 * change (e.g. group rename). Only writes if values differ to avoid
 * unnecessary file churn.
 */
function ensureRuntimeFields(
  containerConfig: import('./container-config.js').ContainerConfig,
  agentGroup: AgentGroup,
): void {
  let dirty = false;
  if (containerConfig.agentGroupId !== agentGroup.id) {
    containerConfig.agentGroupId = agentGroup.id;
    dirty = true;
  }
  if (containerConfig.groupName !== agentGroup.name) {
    containerConfig.groupName = agentGroup.name;
    dirty = true;
  }
  if (containerConfig.assistantName !== agentGroup.name) {
    containerConfig.assistantName = agentGroup.name;
    dirty = true;
  }
  if (dirty) {
    // Race-safe write: re-read container.json immediately before persisting
    // and merge our identity fields onto the freshest disk state. Without
    // this, a concurrent writer (e.g. enable-memory.ts flipping
    // memory.enabled, or any future config-mutating script) can have its
    // update silently clobbered when our write lands later in the spawn
    // flow with a stale in-memory containerConfig.
    //
    // Real-world incident: bulk-enable-memory across 11 groups left 2
    // (video-agent, xerus — the two without a pre-existing agentGroupId
    // in container.json) with memory.enabled=false on disk despite the
    // bulk script writing memory.enabled=true, because the spawn flow's
    // ensureRuntimeFields write-back lost the race.
    const fresh = readContainerConfig(agentGroup.folder);
    fresh.agentGroupId = agentGroup.id;
    fresh.groupName = agentGroup.name;
    fresh.assistantName = agentGroup.name;
    writeContainerConfig(agentGroup.folder, fresh);
    // Sync the in-memory copy with anything the concurrent writer may have
    // added between our read and write — downstream spawn code reads other
    // fields from containerConfig and would otherwise miss those updates.
    if (fresh.memory !== undefined) containerConfig.memory = fresh.memory;
    if (fresh.tools !== undefined) containerConfig.tools = fresh.tools;
    if (fresh.mcpServers !== undefined) containerConfig.mcpServers = fresh.mcpServers;
  }
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
  provider: string,
  providerContribution: ProviderContainerContribution,
  agentIdentifier?: string,
  channelDefaults?: {
    channelDefaultModel: string | null;
    channelDefaultEffort: string | null;
    channelDefaultTone: string | null;
  },
): Promise<string[]> {
  const args: string[] = ['run', '--rm', '--name', containerName, '--label', CONTAINER_INSTALL_LABEL];
  args.push(...dockerResourceLimitArgs());

  // Environment — only vars read by code we don't own.
  // Everything NanoClaw-specific is in container.json (read by runner at startup).
  args.push('-e', `TZ=${TIMEZONE}`);

  // Claude Code behavior locks — duplicated from settings.json env block so
  // the values are set regardless of the SDK's settings-loading order.
  args.push('-e', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY=0');
  args.push('-e', 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80');
  // Claude Code 2.1+ has a built-in auto-compact window default that is well
  // under 200k even when the session uses a 1M-context model (claude-opus-4-7[1m]).
  // Without this override, CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80 fires against the
  // CLI's small default window — sessions compact far earlier than the model's
  // actual capacity. Setting 1_000_000 matches the [1m] capacity so 80% fires
  // around 800k tokens. For non-[1m] sessions the percentage-based trigger still
  // fires at 80% of the model's own context window before this override matters.
  // The CLI itself hints at this value: "override with CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000".
  args.push('-e', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000');
  // Disable adaptive thinking so the CLI uses the older fixed-budget mode that
  // emits visible `thinking` content blocks (what our deriveProgressLabels
  // forwards). The CLI's own gate only actually flips modes when the model id
  // contains "opus-4-6" or "sonnet-4-6"; for 4-7 this is a benign no-op. Keeps
  // behavior consistent when a session explicitly selects 4-6.
  args.push('-e', 'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1');
  // Fixed thinking budget (pairs with disable-adaptive above). max_output − 1
  // for Opus 4.7 = 127999. Deprecated in the SDK query option but still
  // honored as a CLI env knob.
  args.push('-e', 'MAX_THINKING_TOKENS=127999');

  // Default `opus` alias resolution and default effort. The constants
  // at the top of this file (DEFAULT_OPUS_MODEL etc.) are the single
  // source of truth — they're the only "default" surface. Per-channel
  // and per-group layers can override; per-session flags override on
  // top of those. Short aliases (opus46, opus47, etc.) live in the
  // agent-runner flag parser's MODEL_ALIAS_MAP, independent of these.
  //
  // Precedence (most specific wins):
  //   1. Per-session flag in chat (-m / -m1 / -e / -e1) — handled inside
  //      the agent-runner's flag parser, not here.
  //   2. Per-channel wiring (messaging_group_agents.default_model/effort)
  //      — passed via channelDefaults when session has a messaging_group.
  //   3. Per-agent container.json (defaultModel / defaultEffort) —
  //      applies to every channel wired to this agent unless (2) overrides.
  //   4. The DEFAULT_* constants above.
  //
  // ANTHROPIC_DEFAULT_<FAMILY>_MODEL is the SDK's alias resolver
  // short-circuit: whatever string is in that env var gets sent to the
  // API verbatim when the agent or a subagent uses the bare alias.
  const defaultOpusModel = channelDefaults?.channelDefaultModel ?? containerConfig.defaultModel ?? DEFAULT_OPUS_MODEL;
  args.push('-e', `ANTHROPIC_DEFAULT_OPUS_MODEL=${defaultOpusModel}`);
  args.push('-e', `ANTHROPIC_DEFAULT_SONNET_MODEL=${DEFAULT_SONNET_MODEL}`);
  args.push('-e', `ANTHROPIC_DEFAULT_HAIKU_MODEL=${DEFAULT_HAIKU_MODEL}`);

  const defaultEffort = channelDefaults?.channelDefaultEffort ?? containerConfig.defaultEffort ?? DEFAULT_EFFORT;
  args.push('-e', `NANOCLAW_DEFAULT_EFFORT=${defaultEffort}`);

  // Per-channel default tone profile — ports v1's "always-on tone" feature.
  // Precedence: per-channel wiring (messaging_group_agents.default_tone) →
  // per-agent container.json `tone` → unset (agent falls back to the
  // get_tone_profile MCP tool for on-demand selection). Profile content
  // injection happens container-side in agent-runner/src/index.ts.
  const defaultTone = channelDefaults?.channelDefaultTone ?? containerConfig.tone ?? null;
  if (defaultTone) {
    args.push('-e', `NANOCLAW_DEFAULT_TONE=${defaultTone}`);
  }
  // v1 settings.json env block (src/container-runner.ts:1703-1709): SDK
  // capabilities that need explicit opt-in. Porting as plain env since
  // v2's container reads env, not a settings.json mount point.
  args.push('-e', 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1');
  args.push('-e', 'CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1');
  args.push('-e', 'ENABLE_TOOL_SEARCH=true');

  // Per-group Anthropic credentials. Default behaviour reads the global
  // `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` (and `_N` rotation
  // siblings); the per-group form `<BASE>_<FOLDER_UPPER>` overrides the
  // global and pins the *entire* rotation set to the workplace/account
  // tokens for this group only — preventing fallback onto a different
  // account on retryable errors.
  const auth = resolveAnthropicAuth(agentGroup.folder);

  // Optional non-Anthropic routing: when ANTHROPIC_BASE_URL is set on the
  // host, forward it + ANTHROPIC_API_KEY + any ANTHROPIC_API_KEY_N
  // fallbacks to the container so the SDK talks to that endpoint instead
  // of going through the OneCLI proxy. The container's claude provider
  // rotates through the _N keys on retryable errors (429, rate_limit,
  // overloaded, upstream_error, External provider returned).
  //
  // Gated on ANTHROPIC_BASE_URL: without it, keys aren't forwarded and
  // OneCLI's HTTPS proxy injects credentials at request time (default path).
  if (process.env.ANTHROPIC_BASE_URL) {
    args.push('-e', `ANTHROPIC_BASE_URL=${process.env.ANTHROPIC_BASE_URL}`);
    if (auth.apiKeyPrimary) {
      args.push('-e', `ANTHROPIC_API_KEY=${auth.apiKeyPrimary}`);
    }
    for (const fb of auth.apiKeyFallbacks) {
      args.push('-e', `ANTHROPIC_API_KEY_${fb.index}=${fb.value}`);
    }
  }

  // OAuth path (Claude Max subscription). When CLAUDE_CODE_OAUTH_TOKEN is
  // set on the host we forward it + any CLAUDE_CODE_OAUTH_TOKEN_N fallbacks
  // so the provider can rotate through multiple Max accounts on retryable
  // errors (weekly cap, 429, rate_limit). The OneCLI proxy is still applied
  // below, but we add api.anthropic.com to NO_PROXY so Anthropic traffic
  // bypasses OneCLI's credential-injection layer — otherwise the proxy
  // overwrites whatever OAuth the SDK sent with the single vault entry,
  // defeating in-process rotation. Everything else (Gmail, GitHub, Exa,
  // Braintrust, etc.) still routes through OneCLI.
  const hostOauth = auth.oauthPrimary;
  const oauthBypassAnthropic = Boolean(hostOauth);
  if (hostOauth) {
    args.push('-e', `CLAUDE_CODE_OAUTH_TOKEN=${hostOauth}`);
    for (const fb of auth.oauthFallbacks) {
      args.push('-e', `CLAUDE_CODE_OAUTH_TOKEN_${fb.index}=${fb.value}`);
    }
  }

  // GitHub token for git-over-HTTPS + `gh` CLI. Per-agent-group: resolves
  // from container.json `githubTokenEnv`, then from
  // `GITHUB_TOKEN_<FOLDER_UPPER>`, then falls back to `GITHUB_TOKEN`.
  // OneCLI's proxy model doesn't fit git auth — we pass the real token.
  const ghToken = resolveGitHubToken(agentGroup.folder, containerConfig);
  if (ghToken) {
    args.push('-e', `GH_TOKEN=${ghToken}`);
    args.push('-e', `GITHUB_TOKEN=${ghToken}`);
    // Optional URL-scoped credential allowlist. When set, entrypoint.sh
    // configures git's credential helper to only return the token for the
    // listed orgs (comma-separated), and skips the global `gh auth login`
    // so gh's own auth store can't bypass the URL scope. Without this,
    // a container with a broad GitHub token can clone/push to any org
    // the token grants. Per-agent-group via GITHUB_ALLOWED_ORGS_<FOLDER>.
    const ghOrgs = resolveScopedEnv('GITHUB_ALLOWED_ORGS', agentGroup.folder);
    if (ghOrgs) args.push('-e', `GITHUB_ALLOWED_ORGS=${ghOrgs}`);
  } else {
    log.warn('No GitHub token resolved for agent group — git push/PR will fail', {
      folder: agentGroup.folder,
    });
  }

  // Claude Code SDK reads this to discover plugins at
  // /workspace/plugins/<name>/ (mounted by buildMounts from ~/plugins/).
  args.push('-e', 'CLAUDE_PLUGINS_ROOT=/workspace/plugins');

  // Scoped credential env vars: each base resolves via
  // `<BASE>_<FOLDER_UPPER>` → `<BASE>` and is injected if found.
  for (const base of SCOPED_CREDENTIAL_VARS) {
    const v = resolveScopedEnv(base, agentGroup.folder);
    if (v) args.push('-e', `${base}=${v}`);
  }

  // Folder-scoped verbatim env vars: pass through env vars whose name starts
  // with a known prefix AND whose post-prefix tail starts with the folder
  // token followed by `_` or end-of-string. These are raw connection strings
  // (RENDER_PG_URL_ILLYSIUM_ILLYSE_MAIN, etc.) that don't collapse to a base
  // name — the agent uses the full name as-is. Gate on folder to keep
  // cross-group data access from leaking.
  //
  // SECURITY (cross-tenant audit 2026-05-03): the previous check used
  // `includes('_<TOK>_')`, which let folder=axie inherit AXIE_DEV_* vars
  // (substring overlap with axie-dev). The strict prefix-anchored match
  // here, combined with the folder-name collision check at create_agent
  // time, eliminates the ambiguity.
  const folderTok = agentGroup.folder.toUpperCase().replace(/-/g, '_');
  const verbatimPrefixes = ['RENDER_PG_', 'RENDER_REDIS_URL_'];
  for (const [k, v] of Object.entries(process.env)) {
    if (!v) continue;
    const matchedPrefix = verbatimPrefixes.find((p) => k.startsWith(p));
    if (!matchedPrefix) continue;
    const tail = k.slice(matchedPrefix.length);
    if (tail !== folderTok && !tail.startsWith(`${folderTok}_`)) continue;
    args.push('-e', `${k}=${v}`);
  }

  // Per-group opt-in flags from container.json.
  if (containerConfig.gitnexusInjectAgentsMd) {
    args.push('-e', 'GITNEXUS_INJECT_AGENTS_MD=true');
  }
  if (containerConfig.ollamaAdminTools) {
    args.push('-e', 'OLLAMA_ADMIN_TOOLS=true');
  }

  // Memory env vars: injected only when memory is enabled for this group.
  if (containerConfig.memory?.enabled === true) {
    args.push('-e', `MNEMON_STORE=${agentGroup.id}`);
    args.push('-e', 'MNEMON_READ_ONLY=1');
    args.push('-e', 'MNEMON_EMBED_ENDPOINT=http://host.docker.internal:11434');
    args.push('-e', 'MNEMON_EMBED_MODEL=nomic-embed-text');
  }

  // Provider-contributed env vars (e.g. XDG_DATA_HOME, OPENCODE_*, NO_PROXY).
  if (providerContribution.env) {
    for (const [key, value] of Object.entries(providerContribution.env)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  // OneCLI gateway — injects HTTPS_PROXY + certs so container API calls
  // are routed through the agent vault for credential injection.
  // Must ensureAgent first for non-admin groups, otherwise applyContainerConfig
  // rejects the unknown agent identifier and returns false.
  //
  // Skipped entirely when the operator is running a non-Anthropic routing
  // proxy via ANTHROPIC_BASE_URL. The two paths are mutually exclusive:
  // OneCLI intercepts outbound HTTPS at the TCP layer, which would
  // interfere with openlimits / custom-proxy auth. In the BASE_URL path,
  // ANTHROPIC_API_KEY (+ _N fallbacks) forwarded directly by the
  // env-forwarding block above provide auth without OneCLI.
  //
  // When OneCLI IS the path: gateway failure is treated as transient and
  // throws — the caller (router/host-sweep) catches, leaves the inbound
  // message pending, and the next sweep tick retries. Spawning a container
  // with no credentials would only mask the misconfiguration.
  if (process.env.ANTHROPIC_BASE_URL) {
    log.info('Skipping OneCLI gateway — ANTHROPIC_BASE_URL set, using direct proxy', { containerName });
  } else {
    if (agentIdentifier) {
      await onecli.ensureAgent({ name: agentGroup.name, identifier: agentIdentifier });
    }
    const onecliApplied = await onecli.applyContainerConfig(args, { addHostMapping: false, agent: agentIdentifier });
    if (!onecliApplied) {
      throw new Error('OneCLI gateway not applied — refusing to spawn container without credentials');
    }
    log.info('OneCLI gateway applied', { containerName });

    // CA bundle env vars for bundled-CA clients. OneCLI's SDK sets
    // SSL_CERT_FILE / NODE_EXTRA_CA_CERTS / DENO_CERT, but each tool below
    // checks its own var instead. Pointing them at the combined bundle
    // makes future Python/curl/AWS clients trust OneCLI's MITM CA without
    // bespoke NO_PROXY entries. The bypasses below stay as the faster path
    // for hosts where MITM is gratuitous.
    args.push('-e', 'REQUESTS_CA_BUNDLE=/tmp/onecli-combined-ca.pem');
    args.push('-e', 'PIP_CERT=/tmp/onecli-combined-ca.pem');
    args.push('-e', 'CURL_CA_BUNDLE=/tmp/onecli-combined-ca.pem');
    args.push('-e', 'AWS_CA_BUNDLE=/tmp/onecli-combined-ca.pem');
    args.push('-e', 'GIT_SSL_CAINFO=/tmp/onecli-combined-ca.pem');

    // Proxy bypasses for hosts where OneCLI's MITM either breaks the client
    // (bundled CA) or hijacks the auth path with provider routing.
    //
    // Bundled-CA bypass — OneCLI re-signs every CONNECT with its local CA
    // even when injections_applied=0. Clients that ship their own CA bundle
    // reject this and emit "Could not connect to <backend>".
    //   - snowflake-connector-python (snowflake MCP + dbt-snowflake) → certifi
    //   - boto3 / aws-sdk, especially STS → bundled cacerts
    if (isToolEnabled(containerConfig.tools, 'snowflake') || isToolEnabled(containerConfig.tools, 'dbt')) {
      mergeNoProxy(args, 'snowflakecomputing.com');
    }
    if (isToolEnabled(containerConfig.tools, 'aws')) {
      mergeNoProxy(args, 'amazonaws.com');
    }
    // GitHub bypass — git's smart-HTTP protocol uses Basic auth
    // (base64(user:GH_TOKEN)). OneCLI v1.18.6+ recognizes github.com as a
    // known provider and tries to strip+replace that header with its
    // connected-app credential, returning 401 "app not connected
    // provider=github" for any agent without a vault link. Sending the
    // forwarded GH_TOKEN directly to GitHub authenticates both git protocol
    // and api.github.com (gh CLI) equivalently.
    if (ghToken) {
      mergeNoProxy(args, 'github.com');
    }
    // Codex / ChatGPT bypass — codex streams via WebSocket to
    // wss://chatgpt.com/backend-api/codex/responses. OneCLI's MITM doesn't
    // speak WS Upgrade and returns 405 Method Not Allowed, so codex retries
    // five times before falling back to HTTP polling. That retry storm can
    // also stall the codex AppServer enough that getCodexAuthStatus times
    // out and reports loggedIn:false even when auth.json is valid. Bypass
    // is unconditional — non-codex agents don't talk to chatgpt.com.
    mergeNoProxy(args, 'chatgpt.com');
    // pip / Python package install bypass — pip uses certifi and rejects
    // OneCLI's CA with "SSL: CERTIFICATE_VERIFY_FAILED, self-signed
    // certificate in certificate chain". Breaks `install_packages` self-mod
    // and any Python tool that pip-installs at runtime (dbt extensions,
    // ad-hoc packages). Wheels live on files.pythonhosted.org.
    mergeNoProxy(args, 'pypi.org');
    mergeNoProxy(args, 'pythonhosted.org');

    // OAuth bypass: when a host OAuth token is forwarded, tell the
    // in-container HTTPS_PROXY (just configured by OneCLI) to skip
    // api.anthropic.com. Without this, OneCLI's proxy would intercept the
    // Anthropic request and substitute the single vault credential,
    // defeating the provider-level rotation across CLAUDE_CODE_OAUTH_TOKEN_N.
    // We merge with any existing NO_PROXY rather than overwrite so localhost /
    // onecli internal bypasses that OneCLI added stay intact.
    //
    // Also re-append the real OAuth token values AFTER OneCLI applied,
    // because OneCLI injects `-e CLAUDE_CODE_OAUTH_TOKEN=placeholder` to
    // make the SDK happy while relying on its proxy to substitute the real
    // token at request time. Under the bypass path the proxy never fires
    // for api.anthropic.com, so the placeholder would be sent verbatim and
    // the API would reject it as an invalid bearer. Docker's `-e` duplicate-
    // key semantics: last entry wins, so pushing our real values after
    // OneCLI's placeholder is all we need.
    if (oauthBypassAnthropic) {
      mergeNoProxy(args, 'api.anthropic.com');
      stripEnvEntry(args, 'CLAUDE_CODE_OAUTH_TOKEN');
      args.push('-e', `CLAUDE_CODE_OAUTH_TOKEN=${hostOauth}`);
      for (const fb of auth.oauthFallbacks) {
        const key = `CLAUDE_CODE_OAUTH_TOKEN_${fb.index}`;
        stripEnvEntry(args, key);
        args.push('-e', `${key}=${fb.value}`);
      }
    }
  }

  // Host gateway
  args.push(...hostGatewayArgs());

  // User mapping
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  // Volume mounts
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  // Assemble additional MCP servers: container.json's mcpServers (stdio
  // subprocesses the group declares) plus universal HTTP/stdio MCPs
  // (granola, deepwiki, context7, exa, pocket) injected when the relevant
  // key is present on the host. Per-group mcpServers from container.json
  // merged on top so groups can override. Use excludeMcpServers in
  // container.json to opt OUT of specific universals per-group.
  //
  // Granola is a local stdio wrapper around the Granola REST API — replaces
  // the hosted mcp.granola.ai/mcp endpoint (OAuth-only, tokens expired every
  // few hours) with a static-key REST client auto-authed by OneCLI.
  const mcpServers: Record<string, unknown> = { ...(containerConfig.mcpServers ?? {}) };
  const mcpExcluded = new Set(containerConfig.excludeMcpServers ?? []);
  const canInject = (name: string): boolean => !mcpExcluded.has(name) && !mcpServers[name];

  if (canInject('granola')) {
    // Local stdio MCP wrapping Granola's REST API. Replaces the hosted
    // mcp.granola.ai/mcp endpoint whose OAuth session tokens expired silently
    // every few hours and left agents stuck on "Session expired. Please sign
    // in again." OneCLI injects the static `grn_*` bearer token at the HTTPS
    // proxy based on the `public-api.granola.ai` host pattern — see the
    // `GranolaAPI` vault secret. No refresh worker needed.
    mcpServers.granola = {
      type: 'stdio',
      command: 'bun',
      args: ['/app/src/granola-mcp-server.ts'],
    };
  }
  if (canInject('deepwiki')) {
    mcpServers.deepwiki = { type: 'http', url: 'https://mcp.deepwiki.com/mcp' };
  }
  if (canInject('context7')) {
    mcpServers.context7 = {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp'],
      env: {},
    };
  }
  if (canInject('exa')) {
    // Auth header injected by the OneCLI gateway proxy at request time
    // (vault entry "Exa-MCP" → mcp.exa.ai).
    mcpServers.exa = {
      type: 'http',
      url: 'https://mcp.exa.ai/mcp?tools=web_search_exa,web_search_advanced_exa,get_code_context_exa,crawling_exa,company_research_exa,people_search_exa,deep_researcher_start,deep_researcher_check,deep_search_exa',
    };
  }
  if (canInject('pocket')) {
    // Auth header injected by the OneCLI gateway proxy at request time
    // (vault entry "Pocket" → public.heypocketai.com).
    mcpServers.pocket = {
      type: 'http',
      url: 'https://public.heypocketai.com/mcp',
    };
  }
  if (canInject('linear') && isToolEnabled(containerConfig.tools, 'linear')) {
    // Auth header injected by the OneCLI gateway proxy at request time
    // (vault entry "Linear" → mcp.linear.app). Linear's hosted MCP accepts
    // a Personal API Key or OAuth access token as `Authorization: Bearer`.
    // Gated by `tools: ["linear"]` in container.json so groups opt in.
    mcpServers.linear = {
      type: 'http',
      url: 'https://mcp.linear.app/mcp',
    };
  }
  if (canInject('atlassian') && isToolEnabled(containerConfig.tools, 'atlassian')) {
    // sooperset/mcp-atlassian — stdio Python MCP server (72 tools across
    // Jira + Confluence). Installed via /opt/atlassian-venv in the
    // Dockerfile, symlinked to /usr/local/bin/mcp-atlassian.
    //
    // Why direct REST instead of Rovo MCP: the official Rovo MCP requires
    // a per-user permission grant from an Atlassian org admin to expose
    // Jira/Confluence tools — without it, the user only sees 2 Teamwork
    // Graph tools and even those error. Direct REST against
    // <site>.atlassian.net works with any user's standard product seats.
    //
    // The MCP server constructs `Authorization: Basic base64(USERNAME:
    // API_TOKEN)` from env vars at request time. Placeholder values here
    // satisfy the server's startup validation; OneCLI's gateway overrides
    // the constructed header with the real Basic from the vault entry
    // "Atlassian" (hostPattern: madison-reed.atlassian.net) before the
    // request leaves the container. Site URLs are non-secret config and
    // stay literal. Hard-coded to madison-reed today; if other groups
    // ever wire Atlassian we'd resolve site per-folder.
    mcpServers.atlassian = {
      type: 'stdio',
      command: 'mcp-atlassian',
      args: [],
      env: {
        JIRA_URL: 'https://madison-reed.atlassian.net',
        JIRA_USERNAME: 'onecli-managed',
        JIRA_API_TOKEN: 'onecli-managed',
        CONFLUENCE_URL: 'https://madison-reed.atlassian.net/wiki',
        CONFLUENCE_USERNAME: 'onecli-managed',
        CONFLUENCE_API_TOKEN: 'onecli-managed',
      },
    };
  }
  if (canInject('looker') && isToolEnabled(containerConfig.tools, 'looker')) {
    // Google's MCP Toolbox for Databases (--prebuilt looker). The toolbox
    // binary is baked into the image (see container/Dockerfile). Credentials
    // are resolved per-group via LOOKER_*_<FOLDER> → LOOKER_* and embedded
    // in the env block here because the MCP SDK's stdio transport only
    // inherits HOME/LOGNAME/PATH/SHELL/TERM/USER by default — container env
    // vars don't reach the child process unless explicitly passed.
    const baseUrl = resolveScopedEnv('LOOKER_BASE_URL', agentGroup.folder);
    const clientId = resolveScopedEnv('LOOKER_CLIENT_ID', agentGroup.folder);
    const clientSecret = resolveScopedEnv('LOOKER_CLIENT_SECRET', agentGroup.folder);
    if (baseUrl && clientId && clientSecret) {
      mcpServers.looker = {
        type: 'stdio',
        command: 'toolbox',
        args: ['--stdio', '--prebuilt', 'looker'],
        env: {
          LOOKER_BASE_URL: baseUrl,
          LOOKER_CLIENT_ID: clientId,
          LOOKER_CLIENT_SECRET: clientSecret,
          LOOKER_VERIFY_SSL: resolveScopedEnv('LOOKER_VERIFY_SSL', agentGroup.folder) ?? 'true',
        },
      };
    } else {
      log.warn('Looker tool enabled but credentials missing', {
        folder: agentGroup.folder,
        hasBaseUrl: !!baseUrl,
        hasClientId: !!clientId,
        hasClientSecret: !!clientSecret,
      });
    }
  }
  if (canInject('dbt-mcp') && isToolEnabled(containerConfig.tools, 'dbt-mcp')) {
    // dbt-labs/dbt-mcp — Discovery + Semantic Layer + Admin API for dbt Cloud.
    // Binary baked into image via uv (Python 3.12). Token reuses the existing
    // DBT_CLOUD_API_TOKEN_<FOLDER> as DBT_TOKEN. Read-only by default: CLI
    // and LSP toolsets disabled (no local dbt project mounted), and the three
    // mutating Admin tools disabled. Override via DBT_MCP_DISABLE_TOOLS_<FOLDER>.
    const host = resolveScopedEnv('DBT_HOST', agentGroup.folder);
    const token = resolveScopedEnv('DBT_CLOUD_API_TOKEN', agentGroup.folder);
    const prodEnvId = resolveScopedEnv('DBT_PROD_ENV_ID', agentGroup.folder);
    if (host && token && prodEnvId) {
      const env: Record<string, string> = {
        DBT_HOST: host,
        DBT_TOKEN: token,
        DBT_PROD_ENV_ID: prodEnvId,
        DBT_MCP_ENABLE_DBT_CLI: 'false',
        DBT_MCP_ENABLE_LSP: 'false',
        DISABLE_TOOLS:
          resolveScopedEnv('DBT_MCP_DISABLE_TOOLS', agentGroup.folder) ??
          'trigger_job_run,cancel_job_run,retry_job_run',
      };
      const devEnvId = resolveScopedEnv('DBT_DEV_ENV_ID', agentGroup.folder);
      if (devEnvId) env.DBT_DEV_ENV_ID = devEnvId;
      const userId = resolveScopedEnv('DBT_USER_ID', agentGroup.folder);
      if (userId) env.DBT_USER_ID = userId;
      const multicell = resolveScopedEnv('DBT_MULTICELL_ACCOUNT_PREFIX', agentGroup.folder);
      if (multicell) env.MULTICELL_ACCOUNT_PREFIX = multicell;
      mcpServers['dbt-mcp'] = {
        type: 'stdio',
        command: 'dbt-mcp',
        args: [],
        env,
      };
    } else {
      log.warn('dbt-mcp tool enabled but credentials missing', {
        folder: agentGroup.folder,
        hasHost: !!host,
        hasToken: !!token,
        hasProdEnvId: !!prodEnvId,
      });
    }
  }
  if (Object.keys(mcpServers).length > 0) {
    args.push('-e', `NANOCLAW_MCP_SERVERS=${JSON.stringify(mcpServers)}`);
  }

  // Override entrypoint so we skip tini's stdin-read wait (host-spawned
  // sessions don't pipe stdin — all IO flows through the mounted session
  // DBs). Run the image's entrypoint.sh directly via bash so XDG / gws /
  // GitHub-auth / Render / GitNexus setup fires before bun starts.
  args.push('--entrypoint', 'bash');

  const imageTag = containerConfig.imageTag || CONTAINER_IMAGE;
  args.push(imageTag);

  args.push('-c', 'exec /app/entrypoint.sh');

  return args;
}

export function dockerResourceLimitArgs(): string[] {
  const args: string[] = [];
  pushDockerLimit(args, '--memory', CONTAINER_MEMORY_LIMIT);
  pushDockerLimit(args, '--memory-reservation', CONTAINER_MEMORY_RESERVATION);
  pushDockerLimit(args, '--memory-swap', CONTAINER_MEMORY_SWAP_LIMIT);
  if (CONTAINER_PIDS_LIMIT > 0) {
    args.push('--pids-limit', String(CONTAINER_PIDS_LIMIT));
  }
  return args;
}

function pushDockerLimit(args: string[], flag: string, value: string): void {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '0') return;
  args.push(flag, trimmed);
}

/** Build a per-agent-group Docker image with custom packages. */
export async function buildAgentGroupImage(agentGroupId: string): Promise<void> {
  const agentGroup = getAgentGroup(agentGroupId);
  if (!agentGroup) throw new Error('Agent group not found');

  const containerConfig = readContainerConfig(agentGroup.folder);
  const aptPackages = containerConfig.packages.apt;
  const npmPackages = containerConfig.packages.npm;

  if (aptPackages.length === 0 && npmPackages.length === 0) {
    throw new Error('No packages to install. Use install_packages first.');
  }

  let dockerfile = `FROM ${CONTAINER_IMAGE}\nUSER root\n`;
  if (aptPackages.length > 0) {
    dockerfile += `RUN apt-get update && apt-get install -y ${aptPackages.join(' ')} && rm -rf /var/lib/apt/lists/*\n`;
  }
  if (npmPackages.length > 0) {
    // pnpm skips build scripts unless packages are allowlisted. Append each
    // to /root/.npmrc (base image sets it up for agent-browser) so packages
    // with postinstall — e.g. playwright, puppeteer, native addons — don't
    // install silently broken.
    const allowlist = npmPackages.map((p) => `echo 'only-built-dependencies[]=${p}' >> /root/.npmrc`).join(' && ');
    dockerfile += `RUN ${allowlist} && pnpm install -g ${npmPackages.join(' ')}\n`;
  }
  dockerfile += 'USER node\n';

  const imageTag = `${CONTAINER_IMAGE_BASE}:${agentGroupId}`;

  log.info('Building per-agent-group image', { agentGroupId, imageTag, apt: aptPackages, npm: npmPackages });

  // Write Dockerfile to temp file and build
  const tmpDockerfile = path.join(DATA_DIR, `Dockerfile.${agentGroupId}`);
  fs.writeFileSync(tmpDockerfile, dockerfile);
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} build -t ${imageTag} -f ${tmpDockerfile} .`, {
      cwd: DATA_DIR,
      stdio: 'pipe',
      timeout: 300_000,
    });
  } finally {
    fs.unlinkSync(tmpDockerfile);
  }

  // Store the image tag in groups/<folder>/container.json
  containerConfig.imageTag = imageTag;
  writeContainerConfig(agentGroup.folder, containerConfig);

  log.info('Per-agent-group image built', { agentGroupId, imageTag });
}
