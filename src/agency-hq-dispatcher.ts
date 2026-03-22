import {
  DISPATCH_LOOP_INTERVAL,
  STALL_DETECTOR_INTERVAL,
} from './config.js';
import {
  dispatchReadyTasks,
  dispatchRetryCount,
  findDispatchTarget,
  findCeoJid,
  buildPrompt,
} from './dispatch-loop.js';
import {
  detectStalledTasks,
  dispatchTime,
} from './stall-detector.js';
import { logger } from './logger.js';
import type { SchedulerDependencies } from './task-scheduler.js';

// --- Module-level state ---

let stopping = false;
let dispatchIntervalHandle: ReturnType<typeof setInterval> | null = null;
let stallIntervalHandle: ReturnType<typeof setInterval> | null = null;

const isStopping = () => stopping;

// --- Lifecycle ---

export async function startDispatchLoop(
  deps: SchedulerDependencies,
): Promise<void> {
  stopping = false;
  logger.info(
    { intervalMs: DISPATCH_LOOP_INTERVAL },
    'Starting Agency HQ dispatch loop',
  );

  // Run once immediately, then on interval
  dispatchReadyTasks(deps, isStopping).catch((err) =>
    logger.error({ err }, 'Dispatch loop tick failed'),
  );

  dispatchIntervalHandle = setInterval(() => {
    dispatchReadyTasks(deps, isStopping).catch((err) =>
      logger.error({ err }, 'Dispatch loop tick failed'),
    );
  }, DISPATCH_LOOP_INTERVAL);
}

export async function startStallDetector(
  deps: SchedulerDependencies,
): Promise<void> {
  stopping = false;
  logger.info(
    { intervalMs: STALL_DETECTOR_INTERVAL },
    'Starting Agency HQ stall detector',
  );

  stallIntervalHandle = setInterval(() => {
    detectStalledTasks(deps, isStopping).catch((err) =>
      logger.error({ err }, 'Stall detector tick failed'),
    );
  }, STALL_DETECTOR_INTERVAL);
}

export async function stopAgencyHqSubsystems(): Promise<void> {
  stopping = true;
  if (dispatchIntervalHandle) {
    clearInterval(dispatchIntervalHandle);
    dispatchIntervalHandle = null;
  }
  if (stallIntervalHandle) {
    clearInterval(stallIntervalHandle);
    stallIntervalHandle = null;
  }
  dispatchRetryCount.clear();
  dispatchTime.clear();
  logger.info('Agency HQ subsystems stopped');
}

// Exported for testing
export const _testInternals = {
  dispatchRetryCount,
  dispatchTime,
  dispatchReadyTasks: (deps: SchedulerDependencies) =>
    dispatchReadyTasks(deps, isStopping),
  detectStalledTasks: (deps: SchedulerDependencies) =>
    detectStalledTasks(deps, isStopping),
  buildPrompt,
  findDispatchTarget,
  findCeoJid,
  resetStopping: () => {
    stopping = false;
  },
};
