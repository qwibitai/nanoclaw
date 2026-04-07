/**
 * BoxLite runtime abstraction for AgentLite.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 * Replaces the previous container-runtime.ts (Docker-based).
 */

import fs from 'fs';
import path from 'path';

import { JsBoxlite } from '@boxlite-ai/boxlite';

import { logger } from './logger.js';
import type { RuntimeConfig } from './runtime-config.js';

type BoxliteRuntime = InstanceType<typeof JsBoxlite>;

let runtime: BoxliteRuntime | null = null;
let _homeDir: string | undefined;

/** Set the BoxLite home directory. Must be called before getRuntime(). */
export function setBoxliteHome(homeDir: string): void {
  _homeDir = homeDir;
}

/** Get the BoxLite runtime singleton. */
export function getRuntime(): BoxliteRuntime {
  if (!runtime) {
    runtime = _homeDir
      ? new JsBoxlite({ homeDir: _homeDir })
      : JsBoxlite.withDefaultConfig();
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

/** Kill orphaned AgentLite boxes from previous runs. Scoped by instanceName if provided. */
export async function cleanupOrphans(instanceName?: string): Promise<void> {
  try {
    const rt = getRuntime();
    const boxes = await rt.listInfo();
    const prefix = instanceName ? `agentlite-${instanceName}-` : 'agentlite-';
    const orphans = boxes.filter(
      (b: { name?: string; state: { running: boolean } }) =>
        b.name && b.name.startsWith(prefix) && b.state.running,
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
        {
          count: orphans.length,
          names: orphans.map((b: { name?: string }) => b.name),
        },
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

// --- Box spawning (extracted from container-runner) ---

export interface SpawnVolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

export interface SpawnResult {
  box: any;
  execution: any;
}

interface SpawnErrorResult {
  status: 'error';
  result: null;
  error: string;
}

/**
 * Create a BoxLite VM, run the image entrypoint, and write input via stdin.
 * Returns the box + execution handles on success, or an error result.
 */
export async function spawnBox(
  groupName: string,
  containerName: string,
  mounts: SpawnVolumeMount[],
  boxEnv: Record<string, string>,
  userStr: string | undefined,
  stdinData: string,
  rtConfig: RuntimeConfig,
): Promise<SpawnResult | SpawnErrorResult> {
  const runtime = getRuntime();
  const envArray = Object.entries(boxEnv).map(([key, value]) => ({
    key,
    value,
  }));

  let box;
  try {
    // Use local OCI layout if available (from container/build.sh), else pull from registry.
    // Check for oci-layout file to distinguish a valid OCI directory from an empty one.
    const useLocalRootfs =
      rtConfig.boxRootfsPath &&
      fs.existsSync(path.join(rtConfig.boxRootfsPath, 'oci-layout'));
    box = await runtime.create(
      {
        image: useLocalRootfs ? undefined : rtConfig.boxImage,
        rootfsPath: useLocalRootfs ? rtConfig.boxRootfsPath : undefined,
        autoRemove: true,
        memoryMib: rtConfig.boxMemoryMib,
        cpus: rtConfig.boxCpus,
        volumes: mounts.map((m) => ({
          hostPath: m.hostPath,
          guestPath: m.containerPath,
          readOnly: m.readonly,
        })),
        env: envArray,
        workingDir: '/workspace/group',
        user: userStr,
      },
      containerName,
    );
  } catch (err) {
    logger.error(
      { group: groupName, containerName, error: err },
      'Box creation failed',
    );
    return {
      status: 'error',
      result: null,
      error: `Box creation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Run the image's /app/entrypoint.sh via box.exec — box.exec doesn't honor
  // the OCI ENTRYPOINT, so we invoke it explicitly.
  let execution;
  try {
    const timeoutSecs = Math.max(
      Math.floor(rtConfig.containerTimeout / 1000),
      Math.floor((rtConfig.idleTimeout + 30_000) / 1000),
    );

    execution = await box.exec(
      '/app/entrypoint.sh',
      [],
      null, // env already set on box creation
      false, // tty
      null, // user already set on box creation
      timeoutSecs,
      '/workspace/group',
    );
  } catch (err) {
    logger.error(
      { group: groupName, containerName, error: err },
      'Failed to start agent in box',
    );
    try {
      await box.stop();
    } catch {
      /* ignore */
    }
    return {
      status: 'error',
      result: null,
      error: `Failed to start agent: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Write input via stdin (same protocol as Docker's container.stdin.write)
  try {
    const stdin = await execution.stdin();
    await stdin.writeString(stdinData);
    await stdin.close();
  } catch (err) {
    logger.error(
      { group: groupName, containerName, error: err },
      'Failed to write stdin to box',
    );
    try {
      await execution.kill();
    } catch {
      /* ignore */
    }
    try {
      await box.stop();
    } catch {
      /* ignore */
    }
    return {
      status: 'error',
      result: null,
      error: `Failed to write stdin: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { box, execution };
}
