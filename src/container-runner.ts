/**
 * Container Runner v2
 * Spawns agent containers with session folder + agent group folder mounts.
 * The container runs the v2 agent-runner which polls the session DB.
 */
import { ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import { CONTAINER_IMAGE, DATA_DIR, GROUPS_DIR, MAX_MESSAGES_PER_PROMPT, ONECLI_URL, TIMEZONE } from './config.js';
import { readContainerConfig, writeContainerConfig } from './container-config.js';
import { CONTAINER_RUNTIME_BIN, hostGatewayArgs, readonlyMountArgs, stopContainer } from './container-runtime.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getDb, hasTable } from './db/connection.js';
import { initGroupFilesystem } from './group-init.js';
import { stopTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import { validateAdditionalMounts } from './modules/mount-security/index.js';
// Provider host-side config barrel — each provider that needs host-side
// container setup self-registers on import.
import './providers/index.js';
import {
  getProviderContainerConfig,
  type ProviderContainerContribution,
  type VolumeMount,
} from './providers/provider-container-registry.js';
import { markContainerRunning, markContainerStopped, sessionDir, writeSessionRouting } from './session-manager.js';
import type { AgentGroup, Session } from './types.js';

const onecli = new OneCLI({ url: ONECLI_URL });

/** Active containers tracked by session ID. */
const activeContainers = new Map<string, { process: ChildProcess; containerName: string }>();

/**
 * In-flight wake promises, keyed by session id. Deduplicates concurrent
 * `wakeContainer` calls while the first spawn is still mid-setup (async
 * buildContainerArgs, OneCLI gateway apply, etc.) — otherwise a second
 * wake in that window passes the `activeContainers.has` check and spawns
 * a duplicate container against the same session directory, producing
 * racy double-replies.
 */
const wakePromises = new Map<string, Promise<void>>();

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
 */
export function wakeContainer(session: Session): Promise<void> {
  if (activeContainers.has(session.id)) {
    log.debug('Container already running', { sessionId: session.id });
    return Promise.resolve();
  }
  const existing = wakePromises.get(session.id);
  if (existing) {
    log.debug('Container wake already in-flight — joining existing promise', { sessionId: session.id });
    return existing;
  }
  const promise = spawnContainer(session).finally(() => {
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

  // Resolve the effective provider + any host-side contribution it declares
  // (extra mounts, env passthrough). Computed once and threaded through both
  // buildMounts and buildContainerArgs so side effects (mkdir, etc.) fire once.
  const { provider, contribution } = resolveProviderContribution(session, agentGroup);

  const mounts = buildMounts(agentGroup, session, contribution);
  const containerName = `nanoclaw-v2-${agentGroup.folder}-${Date.now()}`;
  // OneCLI agent identifier is always the agent group id — stable across
  // sessions and reversible via getAgentGroup() for approval routing.
  const agentIdentifier = agentGroup.id;
  const args = await buildContainerArgs(mounts, containerName, agentGroup, provider, contribution, agentIdentifier);

  log.info('Spawning container', { sessionId: session.id, agentGroup: agentGroup.name, containerName });

  const container = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  activeContainers.set(session.id, { process: container, containerName });
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

function resolveProviderContribution(
  session: Session,
  agentGroup: AgentGroup,
): { provider: string; contribution: ProviderContainerContribution } {
  const provider = (session.agent_provider || agentGroup.agent_provider || 'claude').toLowerCase();
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
  providerContribution: ProviderContainerContribution,
): VolumeMount[] {
  // Per-group filesystem state lives forever after first creation. Init is
  // idempotent: it only writes paths that don't already exist, so this call
  // is a no-op for groups that have spawned before. Pulling in upstream
  // built-in skill or agent-runner source updates is an explicit operation
  // (host-mediated tools), not something the spawn path does silently.
  initGroupFilesystem(agentGroup);

  const mounts: VolumeMount[] = [];
  const sessDir = sessionDir(agentGroup.id, session.id);
  const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);

  // Session folder at /workspace (contains inbound.db, outbound.db, outbox/, .claude/)
  mounts.push({ hostPath: sessDir, containerPath: '/workspace', readonly: false });

  // Agent group folder at /workspace/agent
  mounts.push({ hostPath: groupDir, containerPath: '/workspace/agent', readonly: false });

  // Global memory directory — always read-only. Edits to global config
  // happen through the approval flow, not by handing one workspace RW.
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    mounts.push({ hostPath: globalDir, containerPath: '/workspace/global', readonly: true });
  }

  // Per-group .claude-shared at /home/node/.claude (Claude state, settings,
  // skills — initialized once at group creation, persistent thereafter)
  const claudeDir = path.join(DATA_DIR, 'v2-sessions', agentGroup.id, '.claude-shared');
  mounts.push({ hostPath: claudeDir, containerPath: '/home/node/.claude', readonly: false });

  // Per-group agent-runner source at /app/src (initialized once at group
  // creation, persistent thereafter — agents can modify their runner)
  const groupRunnerDir = path.join(DATA_DIR, 'v2-sessions', agentGroup.id, 'agent-runner-src');
  mounts.push({ hostPath: groupRunnerDir, containerPath: '/app/src', readonly: false });

  // Additional mounts from container config (groups/<folder>/container.json)
  const containerConfig = readContainerConfig(agentGroup.folder);
  if (containerConfig.additionalMounts && containerConfig.additionalMounts.length > 0) {
    const validated = validateAdditionalMounts(containerConfig.additionalMounts, agentGroup.name);
    mounts.push(...validated);
  }

  // Provider-contributed mounts (e.g. opencode-xdg)
  if (providerContribution.mounts) {
    mounts.push(...providerContribution.mounts);
  }

  return mounts;
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  agentGroup: AgentGroup,
  provider: string,
  providerContribution: ProviderContainerContribution,
  agentIdentifier?: string,
): Promise<string[]> {
  const args: string[] = ['run', '--rm', '--name', containerName];

  // Environment
  args.push('-e', `TZ=${TIMEZONE}`);
  args.push('-e', `AGENT_PROVIDER=${provider}`);
  // Two-DB split: container reads inbound.db, writes outbound.db
  args.push('-e', 'SESSION_INBOUND_DB_PATH=/workspace/inbound.db');
  args.push('-e', 'SESSION_OUTBOUND_DB_PATH=/workspace/outbound.db');
  args.push('-e', 'SESSION_HEARTBEAT_PATH=/workspace/.heartbeat');

  if (agentGroup.name) {
    args.push('-e', `NANOCLAW_ASSISTANT_NAME=${agentGroup.name}`);
  }
  args.push('-e', `NANOCLAW_AGENT_GROUP_ID=${agentGroup.id}`);
  args.push('-e', `NANOCLAW_AGENT_GROUP_NAME=${agentGroup.name}`);
  // Cap on how many pending messages reach one prompt. Accumulated context
  // (trigger=0 rows) rides along with wake-eligible rows up to this cap.
  args.push('-e', `NANOCLAW_MAX_MESSAGES_PER_PROMPT=${MAX_MESSAGES_PER_PROMPT}`);

  // Provider-contributed env vars (e.g. XDG_DATA_HOME, OPENCODE_*, NO_PROXY).
  if (providerContribution.env) {
    for (const [key, value] of Object.entries(providerContribution.env)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  // Per-group env from container.json — overrides provider defaults.
  const containerConfig = readContainerConfig(agentGroup.folder);
  if (containerConfig.env) {
    for (const [key, value] of Object.entries(containerConfig.env)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  // Users allowed to run admin commands (e.g. /clear) inside this container.
  // Computed at wake time: owners + global admins + admins scoped to this
  // agent group. Role changes take effect on next container spawn.
  //
  // SQL inlined to keep core independent of the permissions module — we
  // guard on the `user_roles` table directly. If the permissions module
  // isn't installed, the table doesn't exist and the set stays empty; the
  // formatter treats an empty admin set as permissionless mode (every
  // sender is admin).
  const adminUserIds = new Set<string>();
  if (hasTable(getDb(), 'user_roles')) {
    const db = getDb();
    const owners = db
      .prepare("SELECT user_id FROM user_roles WHERE role = 'owner' AND agent_group_id IS NULL")
      .all() as Array<{ user_id: string }>;
    const globalAdmins = db
      .prepare("SELECT user_id FROM user_roles WHERE role = 'admin' AND agent_group_id IS NULL")
      .all() as Array<{ user_id: string }>;
    const scopedAdmins = db
      .prepare("SELECT user_id FROM user_roles WHERE role = 'admin' AND agent_group_id = ?")
      .all(agentGroup.id) as Array<{ user_id: string }>;
    for (const r of owners) adminUserIds.add(r.user_id);
    for (const r of globalAdmins) adminUserIds.add(r.user_id);
    for (const r of scopedAdmins) adminUserIds.add(r.user_id);
  }
  if (adminUserIds.size > 0) {
    args.push('-e', `NANOCLAW_ADMIN_USER_IDS=${Array.from(adminUserIds).join(',')}`);
  }

  // OneCLI gateway — injects HTTPS_PROXY + certs so container API calls
  // are routed through the agent vault for credential injection.
  // Must ensureAgent first for non-admin groups, otherwise applyContainerConfig
  // rejects the unknown agent identifier and returns false.
  try {
    if (agentIdentifier) {
      await onecli.ensureAgent({ name: agentGroup.name, identifier: agentIdentifier });
    }
    const onecliApplied = await onecli.applyContainerConfig(args, { addHostMapping: false, agent: agentIdentifier });
    if (onecliApplied) {
      log.info('OneCLI gateway applied', { containerName });
    } else {
      log.warn('OneCLI gateway not applied — container will have no credentials', { containerName });
    }
  } catch (err) {
    log.warn('OneCLI gateway error — container will have no credentials', { containerName, err });
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

  // Pass additional MCP servers from container config (groups/<folder>/container.json)
  if (containerConfig.mcpServers && Object.keys(containerConfig.mcpServers).length > 0) {
    args.push('-e', `NANOCLAW_MCP_SERVERS=${JSON.stringify(containerConfig.mcpServers)}`);
  }

  // Override entrypoint: run v2 entry point directly via Bun (no tsc, no stdin).
  // The image's ENTRYPOINT (tini → entrypoint.sh) handles the stdin-piped
  // invocation path; the host-spawned sessions don't need stdin because all
  // IO flows through the mounted session DBs.
  args.push('--entrypoint', 'bash');

  // Use per-agent-group image if one has been built, otherwise base image
  const imageTag = containerConfig.imageTag || CONTAINER_IMAGE;
  args.push(imageTag);

  args.push('-c', 'exec bun run /app/src/index.ts');

  return args;
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

  const imageTag = `nanoclaw-agent:${agentGroupId}`;

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
