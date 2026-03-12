import fs from 'node:fs';
import path from 'node:path';

import type { ProjectRegistry } from './symphony-routing.js';

export type SymphonyRunStatus =
  | 'planned'
  | 'dispatching'
  | 'running'
  | 'review'
  | 'blocked'
  | 'failed'
  | 'done'
  | 'canceled';

export type SymphonyRunRecord = {
  runId: string;
  projectKey: string;
  issueId: string;
  issueIdentifier: string;
  issueTitle: string;
  linearIssueUrl: string;
  notionRoot: string;
  githubRepo: string;
  backend: string;
  status: SymphonyRunStatus;
  workspacePath: string;
  promptFile: string;
  manifestFile: string;
  logFile: string;
  exitFile: string;
  pid: number | null;
  startedAt: string;
  endedAt?: string;
  error?: string;
  resultSummary?: string;
};

export type SymphonyProjectRuntimeSummary = {
  projectKey: string;
  displayName: string;
  symphonyEnabled: boolean;
  readyQueueCount: number;
  activeRunCount: number;
  lastRunStatus: SymphonyRunStatus | 'idle';
  lastRunId?: string;
};

export type SymphonyRuntimeState = {
  updatedAt: string;
  daemonHealthy: boolean;
  daemonPid?: number;
  registryProjectCount: number;
  enabledProjectCount: number;
  projectReadyCounts: Record<string, number>;
  activeRunIds: string[];
  projects: SymphonyProjectRuntimeSummary[];
};

function jsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

export function symphonyRuntimeRoot(): string {
  const registryPath =
    process.env.NANOCLAW_SYMPHONY_REGISTRY_PATH ||
    path.join(process.cwd(), '.nanoclaw', 'symphony', 'project-registry.cache.json');
  return path.dirname(registryPath);
}

export function symphonyRunsRoot(): string {
  return path.join(symphonyRuntimeRoot(), 'runs');
}

export function symphonyPidsRoot(): string {
  return path.join(symphonyRuntimeRoot(), 'pids');
}

export function symphonyRuntimeStatePath(): string {
  return path.join(symphonyRuntimeRoot(), 'state.json');
}

export function ensureSymphonyRuntimeDirs(): void {
  fs.mkdirSync(symphonyRuntimeRoot(), { recursive: true });
  fs.mkdirSync(symphonyRunsRoot(), { recursive: true });
  fs.mkdirSync(symphonyPidsRoot(), { recursive: true });
}

export function buildRunId(issueIdentifier: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `symphony-${issueIdentifier.toLowerCase()}-${stamp}`;
}

export function runRecordPath(runId: string): string {
  return path.join(symphonyRunsRoot(), `${runId}.json`);
}

export function runPidPath(runId: string): string {
  return path.join(symphonyPidsRoot(), `${runId}.json`);
}

export function writeRunRecord(record: SymphonyRunRecord): void {
  ensureSymphonyRuntimeDirs();
  fs.writeFileSync(runRecordPath(record.runId), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  if (record.pid) {
    fs.writeFileSync(
      runPidPath(record.runId),
      `${JSON.stringify(
        {
          runId: record.runId,
          pid: record.pid,
          issueIdentifier: record.issueIdentifier,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }
}

export function readRunRecord(runId: string): SymphonyRunRecord {
  return jsonFile<SymphonyRunRecord>(runRecordPath(runId));
}

export function listRunRecords(): SymphonyRunRecord[] {
  if (!fs.existsSync(symphonyRunsRoot())) {
    return [];
  }
  return fs
    .readdirSync(symphonyRunsRoot())
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => jsonFile<SymphonyRunRecord>(path.join(symphonyRunsRoot(), entry)))
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

export function activeRunRecords(): SymphonyRunRecord[] {
  return listRunRecords().filter((record) =>
    record.status === 'planned' ||
    record.status === 'dispatching' ||
    record.status === 'running',
  );
}

export function writeRuntimeState(state: SymphonyRuntimeState): void {
  ensureSymphonyRuntimeDirs();
  fs.writeFileSync(
    symphonyRuntimeStatePath(),
    `${JSON.stringify(state, null, 2)}\n`,
    'utf8',
  );
}

export function readRuntimeState(): SymphonyRuntimeState | null {
  const filePath = symphonyRuntimeStatePath();
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return jsonFile<SymphonyRuntimeState>(filePath);
}

export function buildRuntimeState(input: {
  registry: ProjectRegistry;
  readyCounts: Record<string, number>;
  daemonHealthy: boolean;
  daemonPid?: number;
  runs?: SymphonyRunRecord[];
}): SymphonyRuntimeState {
  const runs = input.runs || listRunRecords();
  const activeRunIds = runs
    .filter((record) => record.status === 'planned' || record.status === 'dispatching' || record.status === 'running')
    .map((record) => record.runId);

  const projects = input.registry.projects.map((project) => {
    const projectRuns = runs.filter((record) => record.projectKey === project.projectKey);
    const latestRun = projectRuns[0];
    const activeRunCount = projectRuns.filter(
      (record) =>
        record.status === 'planned' ||
        record.status === 'dispatching' ||
        record.status === 'running',
    ).length;

    return {
      projectKey: project.projectKey,
      displayName: project.displayName,
      symphonyEnabled: project.symphonyEnabled,
      readyQueueCount: input.readyCounts[project.projectKey] || 0,
      activeRunCount,
      lastRunStatus: latestRun?.status || 'idle',
      lastRunId: latestRun?.runId,
    };
  });

  return {
    updatedAt: new Date().toISOString(),
    daemonHealthy: input.daemonHealthy,
    daemonPid: input.daemonPid,
    registryProjectCount: input.registry.projects.length,
    enabledProjectCount: input.registry.projects.filter((project) => project.symphonyEnabled).length,
    projectReadyCounts: input.readyCounts,
    activeRunIds,
    projects,
  };
}

export function updateRunRecord(
  runId: string,
  patch: Partial<SymphonyRunRecord>,
): SymphonyRunRecord {
  const next = {
    ...readRunRecord(runId),
    ...patch,
  };
  writeRunRecord(next);
  return next;
}

export function archiveRunRecords(options: {
  olderThanDays?: number;
  statuses?: SymphonyRunRecord['status'][];
}): { archived: number; kept: number } {
  const olderThanDays = options.olderThanDays ?? 7;
  const statuses: SymphonyRunRecord['status'][] = options.statuses ?? ['done', 'failed', 'canceled'];
  const runsRoot = symphonyRunsRoot();
  const archiveDir = path.join(runsRoot, 'archive');

  if (!fs.existsSync(runsRoot)) {
    return { archived: 0, kept: 0 };
  }

  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  fs.mkdirSync(archiveDir, { recursive: true });

  const entries = fs
    .readdirSync(runsRoot)
    .filter((entry) => entry.endsWith('.json'));

  let archived = 0;
  let kept = 0;

  for (const entry of entries) {
    const filePath = path.join(runsRoot, entry);
    let record: SymphonyRunRecord;
    try {
      record = JSON.parse(fs.readFileSync(filePath, 'utf8')) as SymphonyRunRecord;
    } catch {
      kept++;
      continue;
    }

    const startedAt = new Date(record.startedAt);
    const shouldArchive =
      statuses.includes(record.status) &&
      !Number.isNaN(startedAt.getTime()) &&
      startedAt < cutoff;

    if (shouldArchive) {
      fs.renameSync(filePath, path.join(archiveDir, entry));
      archived++;
    } else {
      kept++;
    }
  }

  return { archived, kept };
}
