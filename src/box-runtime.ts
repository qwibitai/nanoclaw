/**
 * BoxLite runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 * Replaces the previous container-runtime.ts (Docker-based).
 */

import { JsBoxlite } from '@boxlite-ai/boxlite';

import { logger } from './logger.js';

type BoxliteRuntime = InstanceType<typeof JsBoxlite>;

let runtime: BoxliteRuntime | null = null;

/** Get the BoxLite runtime singleton. */
export function getRuntime(): BoxliteRuntime {
  if (!runtime) {
    runtime = JsBoxlite.withDefaultConfig();
  }
  return runtime;
}

/** Ensure the BoxLite runtime is available. */
export function ensureRuntimeReady(): void {
  try {
    getRuntime();
    logger.debug('BoxLite runtime ready');
  } catch (err) {
    logger.error({ err }, 'Failed to initialize BoxLite runtime');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: BoxLite runtime failed to initialize                   ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without BoxLite. To fix:                    ║',
    );
    console.error(
      '║  macOS: Ensure Apple Silicon (M1+) and macOS 12+              ║',
    );
    console.error(
      '║  Linux: Ensure /dev/kvm exists and user is in kvm group       ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('BoxLite runtime is required but failed to initialize', {
      cause: err,
    });
  }
}

/** Kill orphaned NanoClaw boxes from previous runs. */
export async function cleanupOrphans(): Promise<void> {
  try {
    const rt = getRuntime();
    const boxes = await rt.listInfo();
    const orphans = boxes.filter(
      (b: { name?: string; state: { running: boolean } }) =>
        b.name && b.name.startsWith('nanoclaw-') && b.state.running,
    );
    for (const box of orphans) {
      try {
        await rt.remove((box as { name: string }).name, true);
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans.map((b: { name?: string }) => b.name) },
        'Stopped orphaned boxes',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned boxes');
  }
}

/** Stop and remove a box by name. */
export async function stopBox(name: string): Promise<void> {
  try {
    const rt = getRuntime();
    await rt.remove(name, true);
  } catch {
    /* already stopped or doesn't exist */
  }
}
