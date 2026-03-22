/**
 * 1Password IPC Handler
 *
 * Handles op_* IPC messages from container agents.
 * Fetches credentials from 1Password CLI on the host.
 *
 * Security:
 * - Only the Dev vault is accessible (hardcoded)
 * - Only read operations (op item get)
 * - Only main group can use this
 */

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

const ALLOWED_VAULT = 'Dev';

interface OpResult {
  success: boolean;
  message: string;
  data?: unknown;
}

function writeResult(
  dataDir: string,
  sourceGroup: string,
  requestId: string,
  result: OpResult,
): void {
  const resultsDir = path.join(dataDir, 'ipc', sourceGroup, 'op_results');
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(
    path.join(resultsDir, `${requestId}.json`),
    JSON.stringify(result),
  );
}

interface OpField {
  label: string;
  value: string;
  id?: string;
  type?: string;
}

interface OpItem {
  fields?: OpField[];
}

async function opGetItem(
  itemName: string,
  field?: string,
): Promise<OpResult> {
  return new Promise((resolve) => {
    const args = [
      'item',
      'get',
      itemName,
      '--vault',
      ALLOWED_VAULT,
      '--format',
      'json',
    ];
    execFile('op', args, { timeout: 15_000 }, (err, stdout) => {
      if (err) {
        resolve({
          success: false,
          message: `1Password error: ${err.message}`,
        });
        return;
      }
      try {
        const item: OpItem = JSON.parse(stdout);
        if (field) {
          const found = item.fields?.find(
            (f) => f.label === field || f.id === field,
          );
          if (found) {
            resolve({
              success: true,
              message: found.value,
              data: { label: found.label, value: found.value },
            });
          } else {
            resolve({
              success: false,
              message: `Field '${field}' not found in item '${itemName}'`,
            });
          }
        } else {
          // Return all fields that have values
          const fields = item.fields
            ?.filter((f) => f.value)
            .map((f) => ({ label: f.label, value: f.value }));
          resolve({ success: true, message: 'OK', data: fields });
        }
      } catch {
        resolve({
          success: false,
          message: 'Failed to parse 1Password output',
        });
      }
    });
  });
}

async function opGetOtp(itemName: string): Promise<OpResult> {
  return new Promise((resolve) => {
    execFile(
      'op',
      ['item', 'get', itemName, '--otp', '--vault', ALLOWED_VAULT],
      { timeout: 15_000 },
      (err, stdout) => {
        if (err) {
          resolve({
            success: false,
            message: `1Password OTP error: ${err.message}`,
          });
        } else {
          resolve({ success: true, message: stdout.trim() });
        }
      },
    );
  });
}

/**
 * Handle 1Password IPC messages from container agents.
 *
 * @returns true if message was handled, false if not an op_* message
 */
export async function handleOpIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
  isMain: boolean,
  dataDir: string,
): Promise<boolean> {
  const type = data.type as string;

  // Only handle op_* types
  if (!type?.startsWith('op_')) {
    return false;
  }

  const requestId = data.requestId as string;
  if (!requestId) {
    logger.warn({ type }, '1Password IPC: missing requestId');
    return true;
  }

  // Only main group can access 1Password
  if (!isMain) {
    logger.warn(
      { sourceGroup, type },
      '1Password IPC blocked: not main group',
    );
    writeResult(dataDir, sourceGroup, requestId, {
      success: false,
      message: '1Password access is restricted to main group only',
    });
    return true;
  }

  const itemName = data.itemName as string;
  if (!itemName) {
    writeResult(dataDir, sourceGroup, requestId, {
      success: false,
      message: 'Missing itemName',
    });
    return true;
  }

  logger.info({ type, requestId, itemName }, 'Processing 1Password request');
  const requestStart = Date.now();

  let result: OpResult;

  switch (type) {
    case 'op_get_item':
      result = await opGetItem(itemName, data.field as string | undefined);
      break;
    case 'op_get_otp':
      result = await opGetOtp(itemName);
      break;
    default:
      return false;
  }

  writeResult(dataDir, sourceGroup, requestId, result);
  const durationMs = Date.now() - requestStart;

  if (result.success) {
    logger.info(
      { type, requestId, durationMs },
      '1Password request completed',
    );
  } else {
    logger.error(
      { type, requestId, durationMs, error: result.message },
      '1Password request failed',
    );
  }

  return true;
}
