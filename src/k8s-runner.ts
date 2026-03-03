/**
 * Kubernetes Job Runner for NanoClaw
 *
 * Replaces container-runner.ts. Each agent invocation is a K8s Job.
 * A shared PVC provides filesystem access between the orchestrator pod
 * and agent Job pods.
 *
 * Isolation model:
 *   Each Job receives only subPath mounts for its own group's directories.
 *   No mount is created for other groups, so agent processes cannot access
 *   other groups' data even if they attempt to traverse the filesystem.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import * as k8s from '@kubernetes/client-node';

import {
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  K8S_NAMESPACE,
  K8S_PVC_NAME,
  K8S_SECRET_NAME,
  K8S_SERVICE_ACCOUNT,
  TIMEZONE,
} from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { getKubeConfig } from './k8s-runtime.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';

export const K8S_AGENT_IMAGE =
  process.env.K8S_AGENT_IMAGE || 'nanoclaw-agent:latest';

// Re-export shared types used by callers (keeps the same interface shape as container-runner)
export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

// ─── PVC path helpers ───────────────────────────────────────────────────────

/**
 * Returns the PVC-relative subdirectory for a request.
 * The orchestrator and Job pods use this the same path on the shared PVC.
 */
function pvcRequestSubPath(groupFolder: string, reqId: string): string {
  return `requests/${groupFolder}/${reqId}`;
}

// ─── Request directory setup ────────────────────────────────────────────────

/**
 * Create the per-request directory on the PVC and write input.json.
 * The orchestrator calls this before creating the Job.
 */
function prepareRequestDir(
  groupFolder: string,
  reqId: string,
  input: ContainerInput,
): string {
  const reqDir = path.join(DATA_DIR, 'requests', groupFolder, reqId);
  const outputDir = path.join(reqDir, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(reqDir, 'input.json'), JSON.stringify(input));
  return reqDir;
}

/** Remove the request directory after the Job completes. */
function cleanupRequestDir(groupFolder: string, reqId: string): void {
  const reqDir = path.join(DATA_DIR, 'requests', groupFolder, reqId);
  try {
    fs.rmSync(reqDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ─── Sessions / skills setup ────────────────────────────────────────────────

function ensureGroupSessionDir(group: RegisteredGroup): string {
  const dir = path.join(DATA_DIR, 'sessions', group.folder, '.claude');
  fs.mkdirSync(dir, { recursive: true });

  const settingsFile = path.join(dir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills from container/skills/ into per-group .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(dir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      fs.cpSync(srcDir, path.join(skillsDst, skillDir), { recursive: true });
    }
  }

  return dir;
}

function ensureGroupAgentRunnerSrc(group: RegisteredGroup): string {
  const projectRoot = process.cwd();
  const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  if (!fs.existsSync(groupAgentRunnerDir) && fs.existsSync(agentRunnerSrc)) {
    fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
  }
  return groupAgentRunnerDir;
}

function ensureGroupIpcDir(group: RegisteredGroup): void {
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
}

// ─── K8s Job spec builder ───────────────────────────────────────────────────

/**
 * Build the K8s Job manifest for one agent invocation.
 *
 * ISOLATION: Each Job receives only subPath mounts for its own group's
 * directories. No mount covers any other group's PVC subdirectory.
 * An agent cannot traverse to another group's data because those paths
 * are simply not mounted inside the container.
 */
function buildJobSpec(
  group: RegisteredGroup,
  reqId: string,
  isMain: boolean,
  timeout: number,
): k8s.V1Job {
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const jobName = `nanoclaw-${safeName}-${reqId}`;

  const volumeMounts: k8s.V1VolumeMount[] = [
    // Own group folder — read/write
    {
      name: 'data',
      mountPath: '/workspace/group',
      subPath: `groups/${group.folder}`,
      readOnly: false,
    },
    // Own IPC namespace — read/write
    {
      name: 'data',
      mountPath: '/workspace/ipc',
      subPath: `ipc/${group.folder}`,
      readOnly: false,
    },
    // Own request directory (input.json + output/) — read/write
    {
      name: 'data',
      mountPath: '/workspace/request',
      subPath: pvcRequestSubPath(group.folder, reqId),
      readOnly: false,
    },
    // Per-group Claude session store — read/write
    {
      name: 'data',
      mountPath: '/home/node/.claude',
      subPath: `sessions/${group.folder}/.claude`,
      readOnly: false,
    },
    // Per-group agent-runner source (customizable) — read/write
    {
      name: 'data',
      mountPath: '/app/src',
      subPath: `sessions/${group.folder}/agent-runner-src`,
      readOnly: false,
    },
  ];

  // Global shared memory (read-only for all groups)
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    volumeMounts.push({
      name: 'data',
      mountPath: '/workspace/global',
      subPath: 'global',
      readOnly: true,
    });
  }

  // Main group gets the project source (read-only)
  if (isMain) {
    volumeMounts.push({
      name: 'data',
      mountPath: '/workspace/project',
      subPath: 'project',
      readOnly: true,
    });
  }

  // Additional validated mounts (from group containerConfig)
  if (group.containerConfig?.additionalMounts) {
    const extra = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    for (const m of extra) {
      // Additional mounts reference host paths — convert to PVC subPaths by
      // stripping DATA_DIR prefix. Only mounts under DATA_DIR are supported.
      const rel = path.relative(DATA_DIR, m.hostPath);
      if (rel.startsWith('..')) {
        logger.warn(
          { group: group.name, hostPath: m.hostPath },
          'Additional mount is outside DATA_DIR, skipping in K8s mode',
        );
        continue;
      }
      volumeMounts.push({
        name: 'data',
        mountPath: m.containerPath,
        subPath: rel,
        readOnly: m.readonly,
      });
    }
  }

  const deadlineSeconds = Math.ceil(timeout / 1000);

  const job: k8s.V1Job = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace: K8S_NAMESPACE,
      labels: { app: 'nanoclaw', group: group.folder },
    },
    spec: {
      // Hard deadline — K8s kills the pod if it runs this long
      activeDeadlineSeconds: deadlineSeconds,
      // Don't restart on failure — let the orchestrator handle retries
      backoffLimit: 0,
      ttlSecondsAfterFinished: 300,
      template: {
        metadata: {
          labels: { app: 'nanoclaw', group: group.folder },
        },
        spec: {
          serviceAccountName: K8S_SERVICE_ACCOUNT,
          restartPolicy: 'Never',
          volumes: [
            {
              name: 'data',
              persistentVolumeClaim: { claimName: K8S_PVC_NAME },
            },
          ],
          containers: [
            {
              name: 'agent',
              image: K8S_AGENT_IMAGE,
              // Secrets injected via K8s Secret (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN)
              envFrom: [{ secretRef: { name: K8S_SECRET_NAME } }],
              env: [{ name: 'TZ', value: TIMEZONE }],
              volumeMounts,
            },
          ],
        },
      },
    },
  };

  return job;
}

// ─── Job lifecycle ──────────────────────────────────────────────────────────

async function createJob(jobSpec: k8s.V1Job): Promise<string> {
  const kc = getKubeConfig();
  const batchApi = kc.makeApiClient(k8s.BatchV1Api);
  const res = await batchApi.createNamespacedJob({
    namespace: K8S_NAMESPACE,
    body: jobSpec,
  });
  return res.metadata!.name!;
}

async function deleteJob(jobName: string): Promise<void> {
  const kc = getKubeConfig();
  const batchApi = kc.makeApiClient(k8s.BatchV1Api);
  try {
    await batchApi.deleteNamespacedJob({
      name: jobName,
      namespace: K8S_NAMESPACE,
      body: { propagationPolicy: 'Background' },
    });
  } catch {
    /* already deleted or never existed */
  }
}

// ─── Output polling ─────────────────────────────────────────────────────────

const OUTPUT_POLL_MS = 500;

/**
 * Poll the request output directory for new result files.
 * Calls onOutput for each new file in sequence order.
 * Resolves when DONE.json appears or the signal fires.
 */
async function pollOutputDir(
  outputDir: string,
  onOutput: (output: ContainerOutput) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  let nextSeq = 0;

  return new Promise((resolve) => {
    let done = false;

    const tick = async () => {
      if (done) return;
      if (signal.aborted) {
        done = true;
        resolve();
        return;
      }

      try {
        const files = fs.readdirSync(outputDir).sort();

        // Process any new numbered output files in order
        for (const file of files) {
          if (!file.endsWith('.json') || file === 'DONE.json') continue;
          const seq = parseInt(file.replace('.json', ''), 10);
          if (isNaN(seq) || seq < nextSeq) continue;
          if (seq === nextSeq) {
            const filePath = path.join(outputDir, file);
            try {
              const output: ContainerOutput = JSON.parse(
                fs.readFileSync(filePath, 'utf-8'),
              );
              nextSeq++;
              await onOutput(output);
            } catch {
              /* file still being written — retry next tick */
            }
          }
        }

        // Check for DONE sentinel
        if (files.includes('DONE.json')) {
          done = true;
          resolve();
          return;
        }
      } catch {
        /* output dir may not exist yet */
      }

      if (!done) {
        setTimeout(tick, OUTPUT_POLL_MS);
      }
    };

    tick();
  });
}

// ─── Project source sync (for main group) ───────────────────────────────────

/**
 * Copy the NanoClaw project source to the PVC so the main group's agent
 * can access it read-only at /workspace/project.
 * Excludes node_modules, data/, store/, and logs/.
 */
export function syncProjectSourceToPvc(): void {
  const projectRoot = process.cwd();
  const pvcProjectDir = path.join(DATA_DIR, 'project');

  const exclude = new Set(['node_modules', 'data', 'store', 'logs', '.git']);

  const copy = (src: string, dst: string) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      if (exclude.has(entry)) continue;
      const srcPath = path.join(src, entry);
      const dstPath = path.join(dst, entry);
      const stat = fs.statSync(srcPath);
      if (stat.isDirectory()) {
        copy(srcPath, dstPath);
      } else {
        fs.copyFileSync(srcPath, dstPath);
      }
    }
  };

  try {
    copy(projectRoot, pvcProjectDir);
    logger.debug({ pvcProjectDir }, 'Project source synced to PVC');
  } catch (err) {
    logger.warn({ err }, 'Failed to sync project source to PVC');
  }
}

// ─── Main orchestration ─────────────────────────────────────────────────────

/**
 * Run an agent as a K8s Job.
 * Equivalent to runContainerAgent() in container-runner.ts.
 */
export async function runK8sJob(
  group: RegisteredGroup,
  input: ContainerInput,
  onJobName: (jobName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const reqId = crypto.randomBytes(6).toString('hex');

  // Ensure group directories exist on the PVC
  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
  ensureGroupIpcDir(group);
  ensureGroupSessionDir(group);
  ensureGroupAgentRunnerSrc(group);

  // Write input.json to the per-request directory on the PVC
  const reqDir = prepareRequestDir(group.folder, reqId, input);
  const outputDir = path.join(reqDir, 'output');

  const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
  const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

  const jobSpec = buildJobSpec(group, reqId, input.isMain, timeoutMs);
  const jobName = jobSpec.metadata!.name!;

  logger.info(
    {
      group: group.name,
      jobName,
      reqId,
      isMain: input.isMain,
    },
    'Creating K8s Job for agent',
  );

  let hadStreamingOutput = false;
  let newSessionId: string | undefined;

  try {
    await createJob(jobSpec);
    onJobName(jobName);

    if (onOutput) {
      const abortController = new AbortController();
      const hardTimeout = setTimeout(() => {
        logger.error({ group: group.name, jobName }, 'Job hard timeout, aborting poll');
        abortController.abort();
      }, timeoutMs);

      let outputChain = Promise.resolve();

      await pollOutputDir(
        outputDir,
        async (result) => {
          if (result.newSessionId) newSessionId = result.newSessionId;
          hadStreamingOutput = true;
          outputChain = outputChain.then(() => onOutput(result));
        },
        abortController.signal,
      );

      clearTimeout(hardTimeout);
      await outputChain;

      const duration = Date.now() - startTime;

      if (abortController.signal.aborted) {
        logger.error(
          { group: group.name, jobName, duration },
          'Job timed out',
        );
        if (hadStreamingOutput) {
          return { status: 'success', result: null, newSessionId };
        }
        return {
          status: 'error',
          result: null,
          error: `Job timed out after ${configTimeout}ms`,
        };
      }

      logger.info(
        { group: group.name, jobName, duration, newSessionId },
        'K8s Job completed (streaming mode)',
      );
      return { status: 'success', result: null, newSessionId };
    }

    // Non-streaming: wait for DONE.json and read the last output file
    const abortController = new AbortController();
    const hardTimeout = setTimeout(
      () => abortController.abort(),
      timeoutMs,
    );
    let lastOutput: ContainerOutput | null = null;
    await pollOutputDir(
      outputDir,
      async (result) => {
        lastOutput = result;
        if (result.newSessionId) newSessionId = result.newSessionId;
      },
      abortController.signal,
    );
    clearTimeout(hardTimeout);

    if (!lastOutput) {
      return {
        status: 'error',
        result: null,
        error: 'Job produced no output',
      };
    }
    const final = lastOutput as ContainerOutput;
    return { ...final, newSessionId: newSessionId ?? final.newSessionId };
  } catch (err) {
    logger.error({ group: group.name, jobName, err }, 'K8s Job error');
    return {
      status: 'error',
      result: null,
      error: `K8s Job error: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    await deleteJob(jobName);
    cleanupRequestDir(group.folder, reqId);
  }
}

// ─── Shared snapshot utilities (formerly in container-runner.ts) ─────────────

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  _registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      { groups: visibleGroups, lastSync: new Date().toISOString() },
      null,
      2,
    ),
  );
}
