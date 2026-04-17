import { OneCLI } from '@onecli-sh/sdk';

import { CONTAINER_IMAGE, TIMEZONE } from '../config.js';
import { hostGatewayArgs, readonlyMountArgs } from '../container-runtime.js';
import { logger } from '../logger.js';

import type { VolumeMount } from './types.js';

/**
 * Build the argv array for the container runtime `run` subcommand,
 * including OneCLI credential gateway config, host UID/GID remapping,
 * volume mounts, and the image reference.
 */
export async function buildContainerArgs(
  onecli: OneCLI,
  mounts: VolumeMount[],
  containerName: string,
  agentIdentifier?: string,
): Promise<string[]> {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // OneCLI gateway handles credential injection — containers never see
  // real secrets. The gateway intercepts HTTPS traffic and injects API
  // keys or OAuth tokens.
  const onecliApplied = await onecli.applyContainerConfig(args, {
    addHostMapping: false, // Nanoclaw already handles host gateway
    agent: agentIdentifier,
  });
  if (onecliApplied) {
    logger.info({ containerName }, 'OneCLI gateway config applied');
  } else {
    logger.warn(
      { containerName },
      'OneCLI gateway not reachable — container will have no credentials',
    );
  }

  // Runtime-specific args for host gateway resolution
  args.push(...hostGatewayArgs());

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid
  // 1000), or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}
