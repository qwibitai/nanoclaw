import fs from 'fs';
import path from 'path';
import { ChildProcess } from 'child_process';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  MAIN_GROUP_FOLDER,
  PARCEL_INITIAL_DELAY,
  PARCEL_POLL_INTERVAL,
} from './config.js';
import { ContainerOutput, runContainerAgent, writeTasksSnapshot } from './container-runner.js';
import { getAllTasks, setSession } from './db.js';
import { readEnvFile } from './env.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface ParcelMonitorDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (groupJid: string, proc: ChildProcess, containerName: string, groupFolder: string) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

interface ParcelDelivery {
  tracking_number: string;
  description?: string;
  carrier_code?: string;
  status_code: number;
  date_expected?: string | null;
  extra_information?: string;
  events?: Array<{ event: string; date: string; location?: string }>;
}

interface ParcelApiResponse {
  success: boolean;
  deliveries: ParcelDelivery[];
}

const STATE_FILE = path.join(DATA_DIR, 'parcel-state.json');

const STATUS_LABELS: Record<number, string> = {
  0: 'Completed',
  1: 'Frozen',
  2: 'In Transit',
  3: 'Awaiting Pickup',
  4: 'Out for Delivery',
  5: 'Not Found',
  6: 'Failed Attempt',
  7: 'Exception',
  8: 'Received',
};

function readState(): ParcelDelivery[] {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function writeState(deliveries: ParcelDelivery[]): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(deliveries, null, 2));
}

/** Extract just the date portion (YYYY-MM-DD) from a date string, ignoring time. */
function dateOnly(d: string | null | undefined): string | null {
  if (!d) return null;
  return d.slice(0, 10);
}

/**
 * Compare old and new delivery lists. Returns a human-readable diff
 * describing noteworthy changes, or null if nothing worth reporting.
 */
function buildDiff(
  oldDeliveries: ParcelDelivery[],
  newDeliveries: ParcelDelivery[],
): string | null {
  const oldMap = new Map(oldDeliveries.map((d) => [d.tracking_number, d]));
  const changes: string[] = [];

  for (const delivery of newDeliveries) {
    const name = delivery.description || delivery.tracking_number;
    const tracking = ` (tracking: ${delivery.tracking_number})`;
    const statusLabel = STATUS_LABELS[delivery.status_code] ?? `Unknown (${delivery.status_code})`;

    const old = oldMap.get(delivery.tracking_number);

    if (!old) {
      // New delivery appeared
      const expectedStr = delivery.date_expected
        ? `, expected ${dateOnly(delivery.date_expected)}`
        : '';
      changes.push(`NEW DELIVERY: "${name}"${tracking} — ${statusLabel}${expectedStr}`);
      continue;
    }

    // Check for exception or failed attempt
    if (
      (delivery.status_code === 6 || delivery.status_code === 7) &&
      old.status_code !== delivery.status_code
    ) {
      changes.push(`EXCEPTION: "${name}" — status is now ${statusLabel}`);
      continue;
    }

    // Check for expected delivery date changes
    const oldDate = dateOnly(old.date_expected);
    const newDate = dateOnly(delivery.date_expected);

    if (!oldDate && newDate) {
      changes.push(`DATE SET: "${name}" — expected delivery is ${newDate}`);
    } else if (oldDate && newDate && oldDate !== newDate) {
      changes.push(`DATE CHANGED: "${name}" — expected delivery changed from ${oldDate} to ${newDate}`);
    }
  }

  if (changes.length === 0) return null;
  return changes.join('\n');
}

async function fetchActiveDeliveries(apiKey: string): Promise<ParcelDelivery[]> {
  const res = await fetch(
    'https://api.parcel.app/external/deliveries/?filter_mode=active',
    { headers: { 'api-key': apiKey } },
  );

  if (!res.ok) {
    throw new Error(`Parcel API error: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as ParcelApiResponse;
  return data.deliveries;
}

function findMainGroupJid(groups: Record<string, RegisteredGroup>): string | null {
  for (const [jid, group] of Object.entries(groups)) {
    if (group.folder === MAIN_GROUP_FOLDER) return jid;
  }
  return null;
}

async function runParcelNotification(
  diffText: string,
  deps: ParcelMonitorDependencies,
  mainJid: string,
  mainGroup: RegisteredGroup,
): Promise<void> {
  const prompt = `[Parcel delivery update] The following changes were detected in active deliveries:

${diffText}

You know which packages I'm especially interested in. Only notify me if:
- A package I told you I care about has a meaningful update
- An expected delivery date appeared or shifted to a different day
- Something moved into an exception or failed state

If none of these warrant a message, do nothing (output nothing).`;

  const groupDir = resolveGroupFolderPath(mainGroup.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const isMain = true;
  const sessions = deps.getSessions();
  const sessionId = sessions[MAIN_GROUP_FOLDER];

  // Update tasks snapshot for container
  const tasks = getAllTasks();
  writeTasksSnapshot(
    MAIN_GROUP_FOLDER,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Close container promptly after result (same pattern as task-scheduler)
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return;
    closeTimer = setTimeout(() => {
      logger.debug('Closing parcel monitor container after result');
      deps.queue.closeStdin(mainJid);
    }, TASK_CLOSE_DELAY_MS);
  };

  try {
    const output = await runContainerAgent(
      mainGroup,
      {
        prompt,
        sessionId,
        groupFolder: MAIN_GROUP_FOLDER,
        chatJid: mainJid,
        isMain,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) => deps.onProcess(mainJid, proc, containerName, MAIN_GROUP_FOLDER),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.newSessionId) {
          const s = deps.getSessions();
          s[MAIN_GROUP_FOLDER] = streamedOutput.newSessionId;
          setSession(MAIN_GROUP_FOLDER, streamedOutput.newSessionId);
        }
        if (streamedOutput.result) {
          await deps.sendMessage(mainJid, streamedOutput.result);
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(mainJid);
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    if (output.newSessionId) {
      const s = deps.getSessions();
      s[MAIN_GROUP_FOLDER] = output.newSessionId;
      setSession(MAIN_GROUP_FOLDER, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error({ error: output.error }, 'Parcel notification container error');
    }
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    logger.error({ err }, 'Parcel notification failed');
  }
}

let monitorRunning = false;

export function startParcelMonitor(deps: ParcelMonitorDependencies): void {
  if (monitorRunning) {
    logger.debug('Parcel monitor already running, skipping duplicate start');
    return;
  }
  monitorRunning = true;

  const envConfig = readEnvFile(['PARCEL_API_KEY']);
  const apiKey = process.env.PARCEL_API_KEY || envConfig.PARCEL_API_KEY;

  if (!apiKey) {
    logger.debug('PARCEL_API_KEY not set, parcel monitor disabled');
    monitorRunning = false;
    return;
  }

  logger.info('Parcel monitor started');

  const tick = async () => {
    try {
      const groups = deps.registeredGroups();
      const mainJid = findMainGroupJid(groups);

      if (!mainJid) {
        logger.debug('No main group registered, skipping parcel check');
        return;
      }

      const mainGroup = groups[mainJid];
      const newDeliveries = await fetchActiveDeliveries(apiKey);
      const oldDeliveries = readState();

      const diff = buildDiff(oldDeliveries, newDeliveries);

      // Always save the latest state
      writeState(newDeliveries);

      if (diff) {
        logger.info('Parcel delivery changes detected, notifying agent');

        deps.queue.enqueueTask(mainJid, 'parcel-monitor', () =>
          runParcelNotification(diff, deps, mainJid, mainGroup),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in parcel monitor tick');
    }

    setTimeout(tick, PARCEL_POLL_INTERVAL);
  };

  // Delay initial check to let the system finish startup
  setTimeout(tick, PARCEL_INITIAL_DELAY);
}

/** @internal - for tests only. */
export function _resetParcelMonitorForTests(): void {
  monitorRunning = false;
}
