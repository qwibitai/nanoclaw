/**
 * Mount Security Module for NanoClaw
 *
 * Validates additional mounts against an allowlist stored OUTSIDE the project root.
 * This prevents container agents from modifying security configuration.
 *
 * Allowlist location: ~/.config/nanoclaw/mount-allowlist.json
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import pino from 'pino';

import { MOUNT_ALLOWLIST_PATH } from './config.js';
import { AdditionalMount, AllowedRoot, ContextTier, MountAllowlist } from './types.js';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

// Cache the allowlist in memory - only reloads on process restart
let cachedAllowlist: MountAllowlist | null = null;
let allowlistLoadError: string | null = null;

/**
 * Default blocked patterns - paths that should never be mounted
 */
const DEFAULT_BLOCKED_PATTERNS = [
  '.ssh',
  '.gnupg',
  '.gpg',
  '.aws',
  '.azure',
  '.gcloud',
  '.kube',
  '.docker',
  'credentials',
  '.env',
  '.netrc',
  '.npmrc',
  '.pypirc',
  'id_rsa',
  'id_ed25519',
  'private_key',
  '.secret',
];

/**
 * Load the mount allowlist from the external config location.
 * Returns null if the file doesn't exist or is invalid.
 * Result is cached in memory for the lifetime of the process.
 */
export function loadMountAllowlist(): MountAllowlist | null {
  if (cachedAllowlist !== null) {
    return cachedAllowlist;
  }

  if (allowlistLoadError !== null) {
    // Already tried and failed, don't spam logs
    return null;
  }

  try {
    if (!fs.existsSync(MOUNT_ALLOWLIST_PATH)) {
      allowlistLoadError = `Mount allowlist not found at ${MOUNT_ALLOWLIST_PATH}`;
      logger.warn(
        { path: MOUNT_ALLOWLIST_PATH },
        'Mount allowlist not found - additional mounts will be BLOCKED. ' +
          'Create the file to enable additional mounts.',
      );
      return null;
    }

    const content = fs.readFileSync(MOUNT_ALLOWLIST_PATH, 'utf-8');
    const allowlist = JSON.parse(content) as MountAllowlist;

    // Validate structure
    if (!Array.isArray(allowlist.allowedRoots)) {
      throw new Error('allowedRoots must be an array');
    }

    if (!Array.isArray(allowlist.blockedPatterns)) {
      throw new Error('blockedPatterns must be an array');
    }

    // Merge with default blocked patterns
    const mergedBlockedPatterns = [
      ...new Set([...DEFAULT_BLOCKED_PATTERNS, ...allowlist.blockedPatterns]),
    ];
    allowlist.blockedPatterns = mergedBlockedPatterns;

    cachedAllowlist = allowlist;
    logger.info(
      {
        path: MOUNT_ALLOWLIST_PATH,
        allowedRoots: allowlist.allowedRoots.length,
        blockedPatterns: allowlist.blockedPatterns.length,
      },
      'Mount allowlist loaded successfully',
    );

    return cachedAllowlist;
  } catch (err) {
    allowlistLoadError = err instanceof Error ? err.message : String(err);
    logger.error(
      {
        path: MOUNT_ALLOWLIST_PATH,
        error: allowlistLoadError,
      },
      'Failed to load mount allowlist - additional mounts will be BLOCKED',
    );
    return null;
  }
}

/**
 * Expand ~ to home directory and resolve to absolute path
 */
export function expandPath(p: string): string {
  const homeDir = process.env.HOME || os.homedir();
  if (p.startsWith('~/')) {
    return path.join(homeDir, p.slice(2));
  }
  if (p === '~') {
    return homeDir;
  }
  return path.resolve(p);
}

/**
 * Get the real path, resolving symlinks.
 * Returns null if the path doesn't exist.
 */
function getRealPath(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Check if a path matches any blocked pattern
 */
function matchesBlockedPattern(
  realPath: string,
  blockedPatterns: string[],
): string | null {
  const pathParts = realPath.split(path.sep);

  for (const pattern of blockedPatterns) {
    // Check if any path component matches the pattern
    for (const part of pathParts) {
      if (part === pattern || part.includes(pattern)) {
        return pattern;
      }
    }

    // Also check if the full path contains the pattern
    if (realPath.includes(pattern)) {
      return pattern;
    }
  }

  return null;
}

/**
 * Check if a real path is under an allowed root
 */
function findAllowedRoot(
  realPath: string,
  allowedRoots: AllowedRoot[],
): AllowedRoot | null {
  for (const root of allowedRoots) {
    const expandedRoot = expandPath(root.path);
    const realRoot = getRealPath(expandedRoot);

    if (realRoot === null) {
      // Allowed root doesn't exist, skip it
      continue;
    }

    // Check if realPath is under realRoot
    const relative = path.relative(realRoot, realPath);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
      return root;
    }
  }

  return null;
}

/**
 * Validate the container path to prevent escaping /workspace/extra/
 */
function isValidContainerPath(containerPath: string): boolean {
  // Must not contain .. to prevent path traversal
  if (containerPath.includes('..')) {
    return false;
  }

  // Must not be absolute (it will be prefixed with /workspace/extra/)
  if (containerPath.startsWith('/')) {
    return false;
  }

  // Must not be empty
  if (!containerPath || containerPath.trim() === '') {
    return false;
  }

  return true;
}

export interface MountValidationResult {
  allowed: boolean;
  reason: string;
  realHostPath?: string;
  effectiveReadonly?: boolean;
}

/**
 * Validate a single additional mount against the allowlist.
 * Access is determined by the tier's entry in the allowed root's access map.
 * Strangers never get access. Friends can only get read-only.
 */
export function validateMount(
  mount: AdditionalMount,
  tier: ContextTier | 'stranger',
): MountValidationResult {
  // Strangers never get external mount access
  if (tier === 'stranger') {
    return {
      allowed: false,
      reason: 'Strangers have no access to external directories',
    };
  }

  const allowlist = loadMountAllowlist();

  // If no allowlist, block all additional mounts
  if (allowlist === null) {
    return {
      allowed: false,
      reason: `No mount allowlist configured at ${MOUNT_ALLOWLIST_PATH}`,
    };
  }

  // Validate container path first (cheap check)
  if (!isValidContainerPath(mount.containerPath)) {
    return {
      allowed: false,
      reason: `Invalid container path: "${mount.containerPath}" - must be relative, non-empty, and not contain ".."`,
    };
  }

  // Expand and resolve the host path
  const expandedPath = expandPath(mount.hostPath);
  const realPath = getRealPath(expandedPath);

  if (realPath === null) {
    return {
      allowed: false,
      reason: `Host path does not exist: "${mount.hostPath}" (expanded: "${expandedPath}")`,
    };
  }

  // Check against blocked patterns
  const blockedMatch = matchesBlockedPattern(
    realPath,
    allowlist.blockedPatterns,
  );
  if (blockedMatch !== null) {
    return {
      allowed: false,
      reason: `Path matches blocked pattern "${blockedMatch}": "${realPath}"`,
    };
  }

  // Check if under an allowed root
  const allowedRoot = findAllowedRoot(realPath, allowlist.allowedRoots);
  if (allowedRoot === null) {
    return {
      allowed: false,
      reason: `Path "${realPath}" is not under any allowed root. Allowed roots: ${allowlist.allowedRoots
        .map((r) => expandPath(r.path))
        .join(', ')}`,
    };
  }

  // Check tier-specific access on the allowed root
  const tierAccess = allowedRoot.access[tier];
  if (!tierAccess) {
    return {
      allowed: false,
      reason: `Tier "${tier}" has no access to root "${allowedRoot.path}"${allowedRoot.description ? ` (${allowedRoot.description})` : ''}`,
    };
  }

  // Determine effective readonly from the tier's access level
  const effectiveReadonly = tierAccess === 'ro';

  if (!effectiveReadonly) {
    logger.debug(
      { mount: mount.hostPath, tier, root: allowedRoot.path },
      'Read-write access granted for tier',
    );
  }

  return {
    allowed: true,
    reason: `Allowed under root "${allowedRoot.path}"${allowedRoot.description ? ` (${allowedRoot.description})` : ''} [${tier}:${tierAccess}]`,
    realHostPath: realPath,
    effectiveReadonly,
  };
}

/**
 * Validate all additional mounts for a group.
 * Returns array of validated mounts (only those that passed validation).
 * Logs warnings for rejected mounts.
 */
export function validateAdditionalMounts(
  mounts: AdditionalMount[],
  groupName: string,
  tier: ContextTier,
): Array<{
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}> {
  const validatedMounts: Array<{
    hostPath: string;
    containerPath: string;
    readonly: boolean;
  }> = [];

  for (const mount of mounts) {
    const result = validateMount(mount, tier);

    if (result.allowed) {
      validatedMounts.push({
        hostPath: result.realHostPath!,
        containerPath: `/workspace/extra/${mount.containerPath}`,
        readonly: result.effectiveReadonly!,
      });

      logger.debug(
        {
          group: groupName,
          hostPath: result.realHostPath,
          containerPath: mount.containerPath,
          readonly: result.effectiveReadonly,
          reason: result.reason,
        },
        'Mount validated successfully',
      );
    } else {
      logger.warn(
        {
          group: groupName,
          requestedPath: mount.hostPath,
          containerPath: mount.containerPath,
          reason: result.reason,
        },
        'Additional mount REJECTED',
      );
    }
  }

  return validatedMounts;
}

/**
 * Generate a template allowlist file for users to customize
 */
export function generateAllowlistTemplate(): string {
  const template: MountAllowlist = {
    allowedRoots: [
      {
        path: '~/projects',
        access: { owner: 'rw', family: 'rw' },
        description: 'Development projects',
      },
      {
        path: '~/Documents',
        access: { owner: 'rw', family: 'ro' },
        description: 'Documents',
      },
    ],
    blockedPatterns: [],
  };

  return JSON.stringify(template, null, 2);
}
