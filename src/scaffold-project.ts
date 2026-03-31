import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { GITHUB_OWNER, PROJECTS_ROOT } from './config.js';
import { logger } from './logger.js';

export interface ScaffoldProjectRequest {
  projectName: string;
  requestedBy: string;
  templateRepo?: string;
  skipGithub?: boolean;
  skipDiscord?: boolean;
}

export interface ScaffoldProjectResult {
  success: boolean;
  error?: string;
  github?: {
    repoUrl: string;
    clonedTo: string;
    alreadyExisted: boolean;
  };
  discord?: {
    channelId: string;
    channelName: string;
    folder: string;
    alreadyExisted: boolean;
  };
}

const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const RESERVED_NAMES = new Set([
  'main',
  'global',
  'test',
  'node-modules',
  'dist',
  'src',
  'node',
]);

/**
 * Validate a project name. Returns null if valid, or an error message string.
 */
export function validateProjectName(name: string): string | null {
  if (!PROJECT_NAME_PATTERN.test(name)) {
    return `Project name must match ${PROJECT_NAME_PATTERN} (lowercase alphanumeric + hyphens, 1-63 chars, starts with alphanumeric)`;
  }
  if (RESERVED_NAMES.has(name)) {
    return `Project name "${name}" is reserved`;
  }
  return null;
}
