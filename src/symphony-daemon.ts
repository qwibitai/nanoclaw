import fs from 'node:fs';

import { dispatchOnceForProject } from './symphony-dispatch.js';
import {
  addIssueComment,
  getIssueByIdentifier,
  listReadyIssuesForProject,
  resolveLinearStateId,
  updateIssueState,
} from './symphony-linear.js';
import { loadProjectRegistryFromFile } from './symphony-registry.js';
import {
  activeRunRecords,
  buildRuntimeState,
  readRunRecord,
  runPidPath,
  updateRunRecord,
  writeRuntimeState,
  type SymphonyRunRecord,
} from './symphony-state.js';

function pidIsAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readExitPayload(filePath: string): { code: number; finishedAt: string } | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
    code: number;
    finishedAt: string;
  };
}

async function transitionIssueForRun(
  run: SymphonyRunRecord,
  statusName: 'Review' | 'Blocked',
  comment: string,
): Promise<void> {
  const issue = await getIssueByIdentifier(run.issueIdentifier);
  const stateId = resolveLinearStateId(issue, statusName);
  await updateIssueState(issue.id, stateId);
  await addIssueComment(issue.id, comment);
}

function cancellationComment(run: SymphonyRunRecord, reason: string): string {
  return [
    '<!-- symphony-stop -->',
    `Run ID: ${run.runId}`,
    `Backend: ${run.backend}`,
    'Status: Blocked',
    `Reason: ${reason}`,
    `Workspace: ${run.workspacePath}`,
    `Log File: ${run.logFile}`,
  ].join('\n');
}

async function reconcileRun(run: SymphonyRunRecord): Promise<SymphonyRunRecord> {
  if (
    run.status !== 'planned' &&
    run.status !== 'dispatching' &&
    run.status !== 'running'
  ) {
    return run;
  }

  const exitPayload = readExitPayload(run.exitFile);
  if (exitPayload) {
    if (exitPayload.code === 0) {
      const next = updateRunRecord(run.runId, {
        status: 'review',
        endedAt: exitPayload.finishedAt,
        resultSummary: 'Backend process exited successfully.',
      });
      await transitionIssueForRun(
        next,
        'Review',
        [
          '<!-- symphony-reconcile -->',
          `Run ID: ${next.runId}`,
          `Backend: ${next.backend}`,
          `Status: Review`,
          `Workspace: ${next.workspacePath}`,
          `Log File: ${next.logFile}`,
        ].join('\n'),
      );
      return next;
    }

    const next = updateRunRecord(run.runId, {
      status: 'failed',
      endedAt: exitPayload.finishedAt,
      error: `Backend exited with code ${exitPayload.code}.`,
      resultSummary: 'Backend process failed.',
    });
    await transitionIssueForRun(
      next,
      'Blocked',
      [
        '<!-- symphony-reconcile -->',
        `Run ID: ${next.runId}`,
        `Backend: ${next.backend}`,
        `Status: Blocked`,
        `Error: ${next.error}`,
        `Workspace: ${next.workspacePath}`,
        `Log File: ${next.logFile}`,
      ].join('\n'),
    );
    return next;
  }

  if (!pidIsAlive(run.pid)) {
    const next = updateRunRecord(run.runId, {
      status: 'failed',
      endedAt: new Date().toISOString(),
      error: 'Backend process exited without writing an exit marker.',
    });
    await transitionIssueForRun(
      next,
      'Blocked',
      [
        '<!-- symphony-reconcile -->',
        `Run ID: ${next.runId}`,
        `Backend: ${next.backend}`,
        `Status: Blocked`,
        `Error: ${next.error}`,
        `Workspace: ${next.workspacePath}`,
        `Log File: ${next.logFile}`,
      ].join('\n'),
    );
    return next;
  }

  if (run.pid && fs.existsSync(runPidPath(run.runId))) {
    fs.writeFileSync(
      runPidPath(run.runId),
      `${JSON.stringify(
        {
          runId: run.runId,
          pid: run.pid,
          issueIdentifier: run.issueIdentifier,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }

  return run;
}

export async function runSymphonyTick(input: {
  registryPath: string;
  autoDispatch?: boolean;
  daemonPid?: number;
}) {
  const registry = loadProjectRegistryFromFile(input.registryPath);
  const readyCounts: Record<string, number> = {};

  for (const project of registry.projects) {
    const issues = await listReadyIssuesForProject(project);
    readyCounts[project.projectKey] = issues.length;
  }

  const currentActiveRuns = activeRunRecords();
  const reconciledRuns: SymphonyRunRecord[] = [];
  for (const run of currentActiveRuns) {
    reconciledRuns.push(await reconcileRun(run));
  }

  if (input.autoDispatch) {
    for (const project of registry.projects) {
      if (!project.symphonyEnabled) continue;
      const hasActiveRun = activeRunRecords().some(
        (record) =>
          record.projectKey === project.projectKey &&
          (record.status === 'planned' ||
            record.status === 'dispatching' ||
            record.status === 'running'),
      );
      if (hasActiveRun) continue;
      if ((readyCounts[project.projectKey] || 0) === 0) continue;
      await dispatchOnceForProject(project);
    }
  }

  writeRuntimeState(
    buildRuntimeState({
      registry,
      readyCounts,
      daemonHealthy: true,
      daemonPid: input.daemonPid,
    }),
  );

  return {
    registryProjectCount: registry.projects.length,
    readyCounts,
    reconciledRunCount: reconciledRuns.length,
    autoDispatch: Boolean(input.autoDispatch),
  };
}

export async function stopSymphonyRun(input: {
  runId: string;
  reason?: string;
}): Promise<{
  run: SymphonyRunRecord;
  processWasAlive: boolean;
}> {
  const run = readRunRecord(input.runId);
  if (
    run.status !== 'planned' &&
    run.status !== 'dispatching' &&
    run.status !== 'running'
  ) {
    throw new Error(
      `Run ${run.runId} is not active and cannot be stopped (current status: ${run.status}).`,
    );
  }

  const reason = input.reason?.trim() || 'Stopped by operator.';
  const processWasAlive = pidIsAlive(run.pid);

  if (processWasAlive && run.pid) {
    process.kill(run.pid, 'SIGTERM');
  }

  if (fs.existsSync(runPidPath(run.runId))) {
    fs.rmSync(runPidPath(run.runId), { force: true });
  }

  const next = updateRunRecord(run.runId, {
    pid: null,
    status: 'canceled',
    endedAt: new Date().toISOString(),
    error: reason,
    resultSummary: 'Run canceled by operator.',
  });

  await transitionIssueForRun(next, 'Blocked', cancellationComment(next, reason));

  return {
    run: next,
    processWasAlive,
  };
}

export async function runSymphonyDaemon(input: {
  registryPath: string;
  pollIntervalMs: number;
  autoDispatch?: boolean;
}) {
  while (true) {
    await runSymphonyTick({
      registryPath: input.registryPath,
      autoDispatch: input.autoDispatch,
      daemonPid: process.pid,
    });
    await new Promise((resolve) => setTimeout(resolve, input.pollIntervalMs));
  }
}
