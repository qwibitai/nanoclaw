/**
 * Container Runner v2
 * Spawns agent containers with session folder + agent group folder mounts.
 * The container runs the v2 agent-runner which polls the session DB.
 */
import { ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  CONTAINER_IMAGE,
  CONTAINER_IMAGE_BASE,
  CONTAINER_INSTALL_LABEL,
  DATA_DIR,
  GROUPS_DIR,
  ONECLI_API_KEY,
  ONECLI_URL,
  TIMEZONE,
} from './config.js';
import { readContainerConfig, writeContainerConfig } from './container-config.js';
import {
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  isSingleProcessMode,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { composeGroupClaudeMd } from './claude-md-compose.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getChannelToken } from './db/baget-channel-tokens.js';
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
import {
  heartbeatPath,
  markContainerRunning,
  markContainerStopped,
  sessionDir,
  writeSessionRouting,
} from './session-manager.js';
import type { AgentGroup, Session } from './types.js';

const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

/**
 * Active containers tracked by session ID.
 *
 * `agentGroupId` is denormalized into the entry so disconnect-side
 * teardown (`killActiveSessionsForAgent`) can filter without a DB
 * round-trip per entry. Reading the spawn-time `agent_group_id` from
 * the in-memory entry is also more reliable than re-reading the
 * `sessions` row, which could drift if a session is deleted while a
 * runner is mid-flight.
 */
type ActiveContainerEntry = {
  process: ChildProcess;
  containerName: string;
  agentGroupId: string;
};
const activeContainers = new Map<string, ActiveContainerEntry>();

/**
 * In-flight wake promises, keyed by session id. Deduplicates concurrent
 * `wakeContainer` calls while the first spawn is still mid-setup (async
 * buildContainerArgs, OneCLI gateway apply, etc.) — otherwise a second
 * wake in that window passes the `activeContainers.has` check and spawns
 * a duplicate container against the same session directory, producing
 * racy double-replies.
 */
const wakePromises = new Map<string, Promise<boolean>>();

/**
 * Per-agent-group concurrency gate (Baget single-process mode).
 *
 * The original docker model isolates each session in its own kernel
 * namespace, so a runaway agent eats only its own container's memory.
 * In single-process mode every session shares the host's RAM — a single
 * misbehaving founder could OOM the whole Railway service if their agent
 * is wedged in a long tool-loop while ten more inbound messages arrive.
 *
 * The gate is per-(user, company), which in our schema is
 * 1:1 with `agent_group_id`. Each agent_group serializes its own turns:
 * a second wake while a turn is in flight chains onto the existing
 * promise instead of spawning a parallel runner. Different founders are
 * still concurrent — no global serialization.
 *
 * Empty in docker mode (where Docker's per-container memory limit
 * provides the same protection more directly).
 */
const groupTurnPromises = new Map<string, Promise<unknown>>();

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

  // In single-process mode, queue this wake behind any in-flight turn for
  // the same agent_group. In docker mode, Docker's per-container memory
  // limit + kernel isolation provide the same protection more directly,
  // so the gate is bypassed.
  const groupId = session.agent_group_id;
  const prevTurn = isSingleProcessMode() ? groupTurnPromises.get(groupId) : undefined;
  const promise = (prevTurn ? prevTurn.catch(() => undefined) : Promise.resolve())
    .then(() => spawnContainer(session))
    .then(() => true)
    .catch((err) => {
      log.warn('wakeContainer failed — host-sweep will retry', { sessionId: session.id, err });
      return false;
    })
    .finally(() => {
      wakePromises.delete(session.id);
      // Only clear the group gate if WE were the latest entry. If a newer
      // wake arrived after us and replaced the slot, leave it — that
      // wake's `.finally` will clear its own slot.
      if (groupTurnPromises.get(groupId) === promise) {
        groupTurnPromises.delete(groupId);
      }
    });
  wakePromises.set(session.id, promise);
  if (isSingleProcessMode()) {
    groupTurnPromises.set(groupId, promise);
  }
  return promise;
}

async function spawnContainer(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    log.error('Agent group not found', { agentGroupId: session.agent_group_id });
    return;
  }

  // Refuse to spawn for an archived agent group. Without this gate,
  // the host sweep can re-wake a session minutes after the founder
  // clicked Disconnect: `getActiveSessions()` filters on
  // `sessions.status = 'active'` only — it has no join against
  // `agent_groups.archived_at`. If a message was pending in
  // `messages_in` at disconnect time, the next sweep tick reads the
  // session, sees `dueCount > 0`, and lands here with an archived
  // agent group. Without this short-circuit, a fresh runner would
  // spawn for a (user, company) that the founder has already
  // disconnected — re-introducing the same stale-reply bug
  // `killActiveSessionsForAgent` was added to fix.
  //
  // Logged at info, not error: this is an EXPECTED outcome on the
  // post-disconnect window, not a malfunction. The pending message
  // stays in `messages_in` and the session stays `status='active'`
  // so a future re-pair (which clears archived_at via
  // `unarchiveBagetAgentGroup`) can still pick up the work — though
  // in practice the channel-token is also gone, so the runner would
  // surface a re-pair prompt rather than silently process old
  // context.
  if (agentGroup.archived_at) {
    log.info('Skipping spawn — agent group is archived (post-disconnect)', {
      agentGroupId: agentGroup.id,
      sessionId: session.id,
      archivedAt: agentGroup.archived_at,
    });
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

  // Single-process branch — Baget on Railway. Skip docker entirely; spawn
  // the agent runner as a child Node process with workspace paths mapped
  // via env vars (see container/agent-runner/src/workspace-paths.ts).
  if (isSingleProcessMode()) {
    return spawnSingleProcessRunner(agentGroup, session, mounts, contribution);
  }

  const containerName = `nanoclaw-v2-${agentGroup.folder}-${Date.now()}`;
  // OneCLI agent identifier is always the agent group id — stable across
  // sessions and reversible via getAgentGroup() for approval routing.
  const agentIdentifier = agentGroup.id;
  const args = await buildContainerArgs(
    mounts,
    containerName,
    agentGroup,
    containerConfig,
    provider,
    contribution,
    agentIdentifier,
  );

  log.info('Spawning container', { sessionId: session.id, agentGroup: agentGroup.name, containerName });

  // Clear any orphan heartbeat from a previous container instance — the
  // sweep's ceiling check treats a missing file as "fresh spawn, give grace"
  // (host-sweep.ts line 87). Without this, the stale mtime can trigger an
  // immediate kill before the new container touches the file itself.
  fs.rmSync(heartbeatPath(agentGroup.id, session.id), { force: true });

  const container = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  activeContainers.set(session.id, { process: container, containerName, agentGroupId: agentGroup.id });
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
  if (isSingleProcessMode()) {
    // No docker container to stop — the entry is a child Node process.
    // SIGTERM first, then SIGKILL via the close handler if it lingers.
    try {
      entry.process.kill('SIGTERM');
    } catch (err) {
      log.warn('SIGTERM failed in single-process mode', { sessionId, err });
      try {
        entry.process.kill('SIGKILL');
      } catch {
        // process already gone
      }
    }
    return;
  }
  try {
    stopContainer(entry.containerName);
  } catch {
    entry.process.kill('SIGKILL');
  }
}

/**
 * Kill every in-flight runner whose `agent_group_id` matches.
 *
 * Called from the Baget admin DELETE handlers after the unbind/deny
 * transaction commits, so a Bun child the founder kicked off seconds
 * before clicking Disconnect doesn't finish its turn and post a stale
 * reply to a now-disconnected channel.
 *
 * Calls `killContainer` per match so docker-mode and single-process
 * mode share the same teardown path. Returns the number of session
 * entries we issued a kill against — `0` is normal (nothing was
 * running for this agent_group at disconnect time).
 *
 * Thread/iterator safety: we snapshot the matching session ids into a
 * plain array BEFORE calling `killContainer` in a loop. Each
 * `killContainer` only mutates the Map indirectly (via the child's
 * `close` handler, which fires asynchronously), but the snapshot makes
 * the iteration unambiguously safe regardless of timing — we never
 * iterate the live Map while another arm of this function is removing
 * from it.
 */
export function killActiveSessionsForAgent(agentGroupId: string, reason: string): number {
  const targetSessionIds: string[] = [];
  for (const [sessionId, entry] of activeContainers) {
    if (entry.agentGroupId === agentGroupId) targetSessionIds.push(sessionId);
  }
  if (targetSessionIds.length === 0) return 0;
  log.info('Killing active runners for agent_group', {
    agentGroupId,
    reason,
    sessionCount: targetSessionIds.length,
  });
  for (const sessionId of targetSessionIds) {
    killContainer(sessionId, reason);
  }
  return targetSessionIds.length;
}

/**
 * Test-only: register a fake `ActiveContainerEntry` so unit tests can
 * exercise `killActiveSessionsForAgent` without spawning real
 * children. Returns a teardown thunk that removes the entry. Production
 * code never calls this — runners are added by `spawnContainer` /
 * `spawnSingleProcessRunner` only.
 */
export function __addActiveContainerForTest(sessionId: string, entry: ActiveContainerEntry): () => void {
  activeContainers.set(sessionId, entry);
  return () => activeContainers.delete(sessionId);
}

/**
 * Single-process spawn: start the agent runner as a child Node process.
 *
 * No Docker, no namespaces — just Node + tsx loading the same
 * agent-runner code that runs inside containers. Workspace paths are
 * remapped via the BAGET_WORKSPACE env var; the runner's
 * workspace-paths.ts honors it to find inbound.db / outbound.db /
 * container.json on the host filesystem instead of /workspace.
 *
 * Provider-contributed env (e.g., XDG_DATA_HOME for opencode) and the
 * additional `extra` mounts both flow into the child via env vars and
 * symlinks respectively — see prepareSingleProcessExtras().
 *
 * Memory + CPU isolation is best-effort (Node `process.resourceUsage`
 * + the per-group concurrency gate above). The OneCLI HTTPS proxy is
 * skipped — in single-process mode the runner's outbound HTTP traffic
 * uses the host process env, which the host already sets up.
 */
async function spawnSingleProcessRunner(
  agentGroup: AgentGroup,
  session: Session,
  mounts: VolumeMount[],
  providerContribution: ProviderContainerContribution,
): Promise<void> {
  const sessDir = sessionDir(agentGroup.id, session.id);
  const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);

  // Materialize the workspace layout on the host: <sessDir> already
  // contains inbound.db / outbound.db; we add `agent` (symlink to
  // groups/<folder>/) and `extra/<name>` (symlinks to provider-contributed
  // RO dirs) so the runner's workspace-paths helpers resolve correctly.
  prepareSingleProcessExtras(sessDir, groupDir, mounts);

  // Resolve the agent-runner entry point. The runner uses `bun:sqlite`
  // directly (db/connection.ts:20), so we MUST run it under bun in
  // single-process mode — same runtime the docker image uses, just
  // spawned without the docker container around it. The `bun` binary
  // is expected on PATH (the Railway Dockerfile installs it).
  //
  // BAGET_BUN_PATH overrides for local dev where bun lives at
  // ~/.bun/bin/bun rather than /usr/local/bin/bun.
  const projectRoot = process.cwd();
  const agentRunnerEntry = path.join(projectRoot, 'container', 'agent-runner', 'src', 'index.ts');
  if (!fs.existsSync(agentRunnerEntry)) {
    throw new Error(`Agent runner entry not found at ${agentRunnerEntry}`);
  }
  const bunBin = process.env.BAGET_BUN_PATH || 'bun';

  // Build the child env with an explicit allowlist — passing the full
  // host env would leak BAGET_ADMIN_TOKEN, TELEGRAM_*, ONECLI_API_KEY,
  // and any other host secret into every spawned runner's
  // /proc/<pid>/environ. The agent has no shell, but a buggy MCP tool
  // that logged process.env would dump them. Allowlist instead.
  //
  // The allowlist includes: standard system vars (PATH, HOME, LANG,
  // NODE_*), Claude SDK auth (ANTHROPIC_API_KEY), and provider-
  // contributed env. Everything else is explicitly NOT propagated.
  const childEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    NODE_OPTIONS: process.env.NODE_OPTIONS,
    NODE_ENV: process.env.NODE_ENV,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    // Proxy settings for outbound HTTP. The OneCLI gateway uses these
    // to route the agent's API traffic through the per-(user, company)
    // bearer-token injection layer in docker mode; on Railway the host
    // ingress may also set them. Either way, the runner's outbound
    // fetches need them or they bypass the proxy and land 401.
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    NO_PROXY: process.env.NO_PROXY,
    // Workspace + identity
    TZ: TIMEZONE,
    BAGET_WORKSPACE: sessDir,
    BAGET_AGENT_GROUP_ID: agentGroup.id,
    BAGET_AGENT_GROUP_NAME: agentGroup.name,
    BAGET_SESSION_ID: session.id,
    // The agent-runner's baget-mcp tools (container/agent-runner/src/
    // mcp-tools/baget.ts) read process.env.BAGET_COMPANY_ID +
    // BAGET_USER_ID directly to construct callbacks like
    // `/api/companies/${companyId}/overview`. agent_groups carries
    // these via migration 014's user_id / company_id columns; for
    // non-Baget rows they're null and the MCP tools surface a clear
    // error to the founder. Keep the explicit-allowlist pattern —
    // never `...process.env`.
    ...(agentGroup.user_id ? { BAGET_USER_ID: agentGroup.user_id } : {}),
    ...(agentGroup.company_id ? { BAGET_COMPANY_ID: agentGroup.company_id } : {}),
  };
  if (providerContribution.env) {
    for (const [k, v] of Object.entries(providerContribution.env)) {
      childEnv[k] = v;
    }
  }

  // Inject the per-(user, company) channel token from local SQLite (see
  // src/db/baget-channel-tokens.ts). The agent-runner's baget-mcp tools
  // read process.env.BAGET_CHANNEL_TOKEN directly to authenticate
  // callbacks into baget.ai's bearer-auth routes (e.g. /api/companies/
  // <id>/overview). When no token has been persisted (pre-bridge baget.ai
  // builds, or the founder hasn't paired yet via the new flow), the env
  // is left unset and the MCP tool surfaces "re-pair from dashboard" to
  // the founder — same UX as the prior OneCLI-vault path.
  //
  // This injection happens AFTER the providerContribution.env loop so a
  // misbehaving provider can't override the channel token. Also placed
  // here (not in the literal above) because it depends on a runtime
  // SQLite read that can't sit in the const initializer. Single SELECT
  // returns value+metadata atomically so the breadcrumb cannot describe
  // a different generation than the value injected.
  const channelToken = getChannelToken(agentGroup.id);
  if (channelToken) {
    childEnv.BAGET_CHANNEL_TOKEN = channelToken.tokenValue;
    log.info('Baget channel-token: injected into spawn env', {
      sessionId: session.id,
      agentGroupId: agentGroup.id,
      // Token VALUE intentionally never logged. Only the metadata
      // timestamps appear here so we can distinguish a fresh persist
      // from a rotation in postmortem timelines.
      persistedAt: channelToken.persistedAt,
      rotatedFromAt: channelToken.rotatedFromAt,
    });
  }

  // Sam 2026-05-06 staging smoke: dispatchApproval(confirmed:true)
  // failed with "BAGET_APPROVAL_CALLBACK_TOKEN missing" even though
  // the var WAS set in Railway env on this service. Root cause: the
  // explicit-allowlist spawn-env above intentionally drops anything
  // not named, and PR #48 (which introduced the new token) didn't
  // add it to the allowlist. Fix: forward the host's
  // BAGET_APPROVAL_CALLBACK_TOKEN into the runner's env so the MCP
  // tool's `getApprovalCallbackToken()` reads it. Same allowlist
  // posture as channel-token: only set when present, never logged.
  if (process.env.BAGET_APPROVAL_CALLBACK_TOKEN) {
    childEnv.BAGET_APPROVAL_CALLBACK_TOKEN =
      process.env.BAGET_APPROVAL_CALLBACK_TOKEN;
  }

  // Clear any orphan heartbeat — same reason as the docker branch.
  fs.rmSync(heartbeatPath(agentGroup.id, session.id), { force: true });

  const containerName = `single-process-${agentGroup.folder}-${session.id}-${Date.now()}`;
  log.info('Spawning single-process runner', {
    sessionId: session.id,
    agentGroup: agentGroup.name,
    containerName,
    sessDir,
  });

  const child = spawn(bunBin, ['run', agentRunnerEntry], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv,
    cwd: path.join(sessDir, 'agent'),
  });

  activeContainers.set(session.id, { process: child, containerName, agentGroupId: agentGroup.id });
  markContainerRunning(session.id);

  child.stderr?.on('data', (data) => {
    for (const line of data.toString().trim().split('\n')) {
      if (line) log.warn(line, { runner: agentGroup.folder });
    }
  });
  child.stdout?.on('data', () => {});

  // Resolve only when the child closes — this is what makes the
  // per-agent_group concurrency gate actually serialize turns
  // (groupTurnPromises in wakeContainer awaits the returned promise).
  // Without this, the gate would only serialize spawn calls, leaving
  // a runaway founder's agent free to fan out N child processes.
  await new Promise<void>((resolve) => {
    child.on('close', (code) => {
      activeContainers.delete(session.id);
      markContainerStopped(session.id);
      stopTypingRefresh(session.id);
      log.info('Single-process runner exited', { sessionId: session.id, code, containerName });
      resolve();
    });
    child.on('error', (err) => {
      activeContainers.delete(session.id);
      markContainerStopped(session.id);
      stopTypingRefresh(session.id);
      log.error('Single-process runner spawn error', { sessionId: session.id, err });
      resolve();
    });
  });
}

/**
 * Materialize the workspace layout on the host so the runner's
 * workspace-paths helpers resolve correctly without bind mounts.
 *
 * Done with symlinks rather than copies so admin changes to
 * groups/<folder>/CLAUDE.local.md / container.json take effect on the
 * next runner spawn (composeGroupClaudeMd in buildMounts already
 * regenerates the composed CLAUDE.md every spawn).
 *
 * Symlink reuse: if a link already points at the correct target we
 * leave it. Mismatched targets are unlinked + recreated.
 */
function prepareSingleProcessExtras(sessDir: string, groupDir: string, mounts: VolumeMount[]): void {
  fs.mkdirSync(sessDir, { recursive: true });

  // <sessDir>/agent → groups/<folder>
  ensureSymlink(path.join(sessDir, 'agent'), groupDir);

  // <sessDir>/extra/<name> for each provider-contributed RO mount whose
  // container path is under /workspace/extra. Skip mounts targeting
  // /workspace/agent or /workspace itself (the agent symlink covers them).
  const extraMounts = mounts.filter((m) => m.containerPath.startsWith('/workspace/extra/'));
  if (extraMounts.length > 0) {
    fs.mkdirSync(path.join(sessDir, 'extra'), { recursive: true });
    for (const m of extraMounts) {
      const name = m.containerPath.slice('/workspace/extra/'.length);
      if (!name || name.includes('/') || name.includes('..')) continue;
      ensureSymlink(path.join(sessDir, 'extra', name), m.hostPath);
    }
  }
}

function ensureSymlink(linkPath: string, target: string): void {
  let needsCreate = true;
  try {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      const current = fs.readlinkSync(linkPath);
      if (current === target) {
        needsCreate = false;
      } else {
        fs.unlinkSync(linkPath);
      }
    } else {
      // Not a symlink — refuse to overwrite (could be a real dir with
      // user data). Caller should investigate.
      throw new Error(`Refusing to overwrite non-symlink at ${linkPath}`);
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') throw err;
  }
  if (needsCreate) {
    fs.symlinkSync(target, linkPath);
  }
}

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

export function resolveAssistantName(agentGroup: Pick<AgentGroup, 'name' | 'company_id'>): string | undefined {
  // Baget founder groups impersonate a team of roles, not a single assistant.
  // Using the company name here makes the model answer "I am <company>" when
  // asked who it is, which fights the Louis/Valentin/... persona layer.
  return agentGroup.company_id ? undefined : agentGroup.name;
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

  // Session folder at /workspace (contains inbound.db, outbound.db, outbox/, .claude/)
  mounts.push({ hostPath: sessDir, containerPath: '/workspace', readonly: false });

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

  // Shared CLAUDE.md — read-only, imported by the composed entry point via
  // the `.claude-shared.md` symlink inside the group dir.
  const sharedClaudeMd = path.join(process.cwd(), 'container', 'CLAUDE.md');
  if (fs.existsSync(sharedClaudeMd)) {
    mounts.push({ hostPath: sharedClaudeMd, containerPath: '/app/CLAUDE.md', readonly: true });
  }

  // Per-group .claude-shared at /home/node/.claude (Claude state, settings,
  // skill symlinks)
  mounts.push({ hostPath: claudeDir, containerPath: '/home/node/.claude', readonly: false });

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
  const assistantName = resolveAssistantName(agentGroup);
  if ((containerConfig.assistantName ?? undefined) !== assistantName) {
    if (assistantName) {
      containerConfig.assistantName = assistantName;
    } else {
      delete containerConfig.assistantName;
    }
    dirty = true;
  }
  if (dirty) {
    writeContainerConfig(agentGroup.folder, containerConfig);
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
): Promise<string[]> {
  const args: string[] = ['run', '--rm', '--name', containerName, '--label', CONTAINER_INSTALL_LABEL];

  // Environment — only vars read by code we don't own.
  // Everything NanoClaw-specific is in container.json (read by runner at startup).
  args.push('-e', `TZ=${TIMEZONE}`);

  // Provider-contributed env vars (e.g. XDG_DATA_HOME, OPENCODE_*, NO_PROXY).
  if (providerContribution.env) {
    for (const [key, value] of Object.entries(providerContribution.env)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  // OneCLI gateway — injects HTTPS_PROXY + certs so container API calls
  // are routed through the agent vault for credential injection. Treated as
  // a transient hard failure: if we can't wire the gateway, we don't spawn.
  // The caller (router or host-sweep) catches the throw, leaves the inbound
  // message pending, and the next sweep tick retries.
  if (agentIdentifier) {
    await onecli.ensureAgent({ name: agentGroup.name, identifier: agentIdentifier });
  }
  const onecliApplied = await onecli.applyContainerConfig(args, { addHostMapping: false, agent: agentIdentifier });
  if (!onecliApplied) {
    throw new Error('OneCLI gateway not applied — refusing to spawn container without credentials');
  }
  log.info('OneCLI gateway applied', { containerName });

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

  // Override entrypoint: run v2 entry point directly via Bun (no tsc, no stdin).
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
