import { exec } from 'child_process';
import util from 'util';
import { logger } from './logger.js';
import { GoogleWorkspaceConfig } from './types.js';

const execAsync = util.promisify(exec);

/**
 * Parse a specific flag's JSON value from command args.
 * Returns the parsed object or null if the flag is absent / value is invalid JSON.
 */
function parseJsonFlag(
  commandArgs: string[],
  flag: string,
): Record<string, any> | null {
  for (let i = 0; i < commandArgs.length; i++) {
    if (commandArgs[i] === flag && i + 1 < commandArgs.length) {
      try {
        return JSON.parse(commandArgs[i + 1]);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Extract the primary resource ID from --params for the given service.
 * This is the ID that the API call will actually operate on.
 * Returns null if the params don't contain a primary ID (e.g. list operations).
 */
function extractPrimaryIdFromParams(
  service: string,
  params: Record<string, any> | null,
): string | null {
  if (!params) return null;
  if (service === 'sheets' && typeof params.spreadsheetId === 'string') {
    return params.spreadsheetId;
  }
  if (service === 'docs' && typeof params.documentId === 'string') {
    return params.documentId;
  }
  if (service === 'drive' && typeof params.fileId === 'string') {
    return params.fileId;
  }
  return null;
}

/**
 * Validate that a resource ID is in an allowed location by querying the Drive API.
 * Returns an error string if access is denied, or null if allowed.
 */
async function validateResourceLocation(
  resourceId: string,
  gwConfig: GoogleWorkspaceConfig,
): Promise<string | null> {
  const safeId = resourceId.replace(/[^a-zA-Z0-9-_]/g, '');
  if (!safeId) return `Invalid resource ID format: '${resourceId}'`;

  try {
    const getCmd = `/opt/homebrew/bin/gws drive files get --params '{"fileId": "${safeId}", "fields": "driveId,parents"}' --format json`;
    const { stdout } = await execAsync(getCmd);
    const fileMeta = JSON.parse(stdout);

    const fileDriveId = fileMeta.driveId;
    const fileParents: string[] = fileMeta.parents || [];

    const inAllowedDrive =
      fileDriveId && gwConfig.allowedDrives?.includes(fileDriveId);
    const inAllowedFolder = fileParents.some((p) =>
      gwConfig.allowedFolders?.includes(p),
    );
    const explicitlyAllowedFolder =
      gwConfig.allowedFolders?.includes(resourceId);

    if (!inAllowedDrive && !inAllowedFolder && !explicitlyAllowedFolder) {
      return `Access denied. Resource '${resourceId}' is not in an allowed drive or folder.`;
    }
    return null;
  } catch (err: any) {
    if (err.message && err.message.includes('not found')) {
      return `Resource '${resourceId}' not found or you don't have access to check permissions.`;
    }
    return `Failed to validate permissions for resource: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function executeGoogleWorkspaceCommand(
  gwConfig: GoogleWorkspaceConfig | undefined,
  service: string,
  commandArgs: string[],
  resourceId?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const deny = (reason: string) => {
    logger.warn({ service, resourceId, reason }, 'GWS command denied');
    return { stdout: '', stderr: reason, exitCode: 1 };
  };

  if (!gwConfig) {
    return deny('Google Workspace is not configured for this group.');
  }

  // --- 1. Service allowlist ---
  const allowedServices = gwConfig.allowedServices ?? ['drive'];
  if (!allowedServices.includes(service)) {
    return deny(
      `Service '${service}' not allowed. Allowed: ${allowedServices.join(', ')}`,
    );
  }

  // --- 2. Drive-based services require folder/drive config + resource_id ---
  const driveServices = ['drive', 'sheets', 'docs'];
  const isDriveService = driveServices.includes(service);

  if (isDriveService) {
    if (!gwConfig.allowedDrives?.length && !gwConfig.allowedFolders?.length) {
      return deny(
        'No allowedDrives or allowedFolders configured. Drive-based services require explicit resource access.',
      );
    }
    if (!resourceId) {
      return deny(
        'resource_id is required for drive-based services. Pass the folder or file ID you want to access.',
      );
    }
  }

  if (isDriveService) {
    const hasMethod = (method: string) =>
      commandArgs.some((arg) => arg === method);
    const jsonBody = parseJsonFlag(commandArgs, '--json');
    const params = parseJsonFlag(commandArgs, '--params');

    // --- 3. Validate the resource actually being accessed matches resource_id ---
    //
    // The agent controls resource_id. Without this check it can pass an allowed
    // folder ID as resource_id while the real target is in --params (e.g.
    // spreadsheetId pointing to a file outside allowed folders).
    //
    // If --params contains a primary ID (spreadsheetId / documentId / fileId)
    // that ID IS the resource being operated on — it must match resource_id.
    const primaryId = extractPrimaryIdFromParams(service, params);
    if (primaryId !== null && primaryId !== resourceId) {
      return deny(
        `resource_id '${resourceId}' does not match the primary ID in --params ('${primaryId}'). ` +
          `Pass the actual resource ID as resource_id.`,
      );
    }

    // --- 4. Mutation guards (create / copy / delete / move / share) ---
    // These apply whenever folder or drive restrictions are configured.
    const hasFolderRestriction =
      gwConfig.allowedFolders?.length || gwConfig.allowedDrives?.length;

    if (hasFolderRestriction) {
      // 4a. Block create on sheets/docs — Sheets/Docs APIs always create in
      //     Drive root with no way to specify a parent folder.
      //     File creation must go through `drive files create` with explicit parents.
      if ((service === 'sheets' || service === 'docs') && hasMethod('create')) {
        return deny(
          `Create operations on ${service} are not allowed — the ${service} API always creates files in Drive root. ` +
            `Use service "drive" with: files create --json '{"name": "...", "mimeType": "application/vnd.google-apps.${service === 'sheets' ? 'spreadsheet' : 'document'}", "parents": ["FOLDER_ID"]}'. ` +
            (gwConfig.allowedFolders?.length
              ? `Allowed folders: [${gwConfig.allowedFolders.join(', ')}]`
              : `Allowed drives: [${gwConfig.allowedDrives!.join(', ')}]`),
        );
      }

      // 4b. drive files create: require parents in --json and validate them
      if (service === 'drive' && hasMethod('create') && commandArgs.includes('files')) {
        if (
          !jsonBody ||
          !jsonBody.parents ||
          !Array.isArray(jsonBody.parents) ||
          jsonBody.parents.length === 0
        ) {
          return deny(
            `Create operations require "parents" in --json body. ` +
              `Example: --json '{"name": "...", "parents": ["FOLDER_ID"]}'. ` +
              (gwConfig.allowedFolders?.length
                ? `Allowed folders: [${gwConfig.allowedFolders.join(', ')}]`
                : `Allowed drives: [${gwConfig.allowedDrives!.join(', ')}]`),
          );
        }
        if (gwConfig.allowedFolders?.length) {
          const invalidParents = jsonBody.parents.filter(
            (id: string) => !gwConfig.allowedFolders!.includes(id),
          );
          if (invalidParents.length > 0) {
            return deny(
              `Parent folders [${invalidParents.join(', ')}] are not allowed. ` +
                `Allowed: [${gwConfig.allowedFolders.join(', ')}]`,
            );
          }
        }
        logger.info(
          { service, operation: 'create', parents: jsonBody.parents },
          'GWS create validated: parents allowed',
        );
      }

      // 4c. drive files copy: validate destination parents
      if (service === 'drive' && hasMethod('copy')) {
        if (
          gwConfig.allowedFolders?.length &&
          jsonBody?.parents &&
          Array.isArray(jsonBody.parents)
        ) {
          const invalidParents = jsonBody.parents.filter(
            (id: string) => !gwConfig.allowedFolders!.includes(id),
          );
          if (invalidParents.length > 0) {
            return deny(
              `Copy destination folders [${invalidParents.join(', ')}] are not allowed. ` +
                `Allowed: [${gwConfig.allowedFolders.join(', ')}]`,
            );
          }
        }
        if (gwConfig.allowedFolders?.length && (!jsonBody?.parents || !Array.isArray(jsonBody.parents))) {
          return deny(
            `Copy operations require "parents" in --json body to control destination. ` +
              `Allowed folders: [${gwConfig.allowedFolders.join(', ')}]`,
          );
        }
      }

      // 4d. Block file movement via addParents/removeParents in update
      if (service === 'drive' && hasMethod('update') && params) {
        if (params.addParents || params.removeParents) {
          return deny(
            'Moving files between folders (addParents/removeParents) is not allowed.',
          );
        }
      }

      // 4e. Block file and revision deletion
      if (service === 'drive' && hasMethod('delete')) {
        if (
          commandArgs.includes('files') ||
          commandArgs.includes('revisions')
        ) {
          return deny('Deleting files or revisions is not allowed.');
        }
      }

      // 4f. Block external sharing via permissions create
      if (
        service === 'drive' &&
        commandArgs.includes('permissions') &&
        hasMethod('create')
      ) {
        return deny('Creating file permissions (sharing) is not allowed.');
      }
    }

    // --- 5. Validate resource_id location ---
    //
    // For create operations, the file doesn't exist yet — skip location check.
    // The parents in --json were already validated in step 4b.
    const isDriveCreate =
      service === 'drive' &&
      hasMethod('create') &&
      commandArgs.includes('files');

    if (!isDriveCreate) {
      const locationError = await validateResourceLocation(resourceId!, gwConfig);
      if (locationError) {
        return deny(locationError);
      }
      logger.info({ service, resourceId }, 'GWS resource access granted');
    }
  }

  // --- 6. Execute the command ---
  const safeArgs = commandArgs.map((arg) => {
    return `'${arg.replace(/'/g, "'\\''")}'`;
  });

  const commandLine = `/opt/homebrew/bin/gws ${service} ${safeArgs.join(' ')}`;

  logger.info({ service, resourceId, commandLine }, 'GWS command executing');

  try {
    const { stdout, stderr } = await execAsync(commandLine);
    logger.info(
      { service, resourceId, stdoutLen: stdout.length },
      'GWS command succeeded',
    );
    return { stdout, stderr, exitCode: 0 };
  } catch (err: any) {
    logger.warn(
      {
        service,
        resourceId,
        exitCode: err.code,
        stderr: err.stderr?.slice(0, 200),
      },
      'GWS command failed',
    );
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || err.message,
      exitCode: err.code || 1,
    };
  }
}
