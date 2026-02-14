/**
 * Hetzner Cloud API wrapper.
 * Provides lifecycle management for Hetzner Cloud servers (VMs).
 */

import { HETZNER_API_TOKEN } from '../config.js';
import { logger } from '../logger.js';

const HETZNER_API_URL = 'https://api.hetzner.cloud/v1';

/** Hetzner API responses use endpoint-specific shapes. */
interface SSHKeyResponse { ssh_key: HetznerSSHKey; }
interface ServerResponse { server: HetznerServer; action: HetznerAction; }
interface ServerGetResponse { server: HetznerServer; }
interface ActionResponse { action: HetznerAction; }
interface DeleteResponse { action: HetznerAction; }

interface HetznerError {
  error: {
    code: string;
    message: string;
  };
}

async function hetznerApi<T>(
  method: string,
  endpoint: string,
  body?: unknown,
): Promise<T> {
  if (!HETZNER_API_TOKEN) {
    throw new Error('HETZNER_API_TOKEN not set');
  }

  const url = `${HETZNER_API_URL}${endpoint}`;
  const options: RequestInit = {
    method,
    headers: {
      'Authorization': `Bearer ${HETZNER_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);
  let resp: Response;
  try {
    resp = await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }

  // Handle empty responses (204 No Content, e.g. DELETE operations)
  let json: unknown = {};
  const contentLength = resp.headers.get('content-length');
  if (resp.status !== 204 && contentLength !== '0') {
    json = await resp.json();
  }

  if (!resp.ok) {
    const error = json as HetznerError;
    throw new Error(`Hetzner API error: ${error.error?.message || resp.statusText}`);
  }

  return json as T;
}

export interface HetznerServer {
  id: number;
  name: string;
  status: 'running' | 'initializing' | 'starting' | 'stopping' | 'off' | 'deleting' | 'migrating' | 'rebuilding' | 'unknown';
  public_net: {
    ipv4: { ip: string };
    ipv6: { ip: string };
  };
  created: string;
}

export interface HetznerSSHKey {
  id: number;
  name: string;
  fingerprint: string;
  public_key: string;
}

export interface HetznerAction {
  id: number;
  status: 'running' | 'success' | 'error';
  command: string;
  error?: {
    code: string;
    message: string;
  };
}

/** Create a new SSH key. */
export async function createSSHKey(name: string, publicKey: string): Promise<HetznerSSHKey> {
  const data = await hetznerApi<SSHKeyResponse>('POST', '/ssh_keys', {
    name,
    public_key: publicKey,
  });
  logger.info({ keyId: data.ssh_key.id, name }, 'Created Hetzner SSH key');
  return data.ssh_key;
}

/** Delete an SSH key. */
export async function deleteSSHKey(keyId: number): Promise<void> {
  await hetznerApi<unknown>('DELETE', `/ssh_keys/${keyId}`);
  logger.info({ keyId }, 'Deleted Hetzner SSH key');
}

/** Create a new server (VM). */
export async function createServer(
  name: string,
  serverType: string,
  image: string,
  location: string,
  sshKeys: number[],
  userData?: string,
): Promise<{ server: HetznerServer; action: HetznerAction }> {
  const data = await hetznerApi<ServerResponse>('POST', '/servers', {
    name,
    server_type: serverType,
    image,
    location,
    start_after_create: true,
    ssh_keys: sshKeys,
    user_data: userData,
  });
  logger.info(
    { serverId: data.server.id, name, serverType, location },
    'Created Hetzner server',
  );
  return { server: data.server, action: data.action };
}

/** Get server status. */
export async function getServer(serverId: number): Promise<HetznerServer> {
  const data = await hetznerApi<ServerGetResponse>('GET', `/servers/${serverId}`);
  return data.server;
}

/** Delete a server. */
export async function deleteServer(serverId: number): Promise<HetznerAction> {
  const data = await hetznerApi<DeleteResponse>('DELETE', `/servers/${serverId}`);
  logger.info({ serverId }, 'Deleted Hetzner server');
  return data.action;
}

/** Get action status. */
export async function getAction(actionId: number): Promise<HetznerAction> {
  const data = await hetznerApi<ActionResponse>('GET', `/actions/${actionId}`);
  return data.action;
}

/** Wait for an action to complete. */
export async function waitForAction(actionId: number, maxWaitMs = 300000): Promise<void> {
  const startTime = Date.now();
  const pollInterval = 2000;

  while (Date.now() - startTime < maxWaitMs) {
    const action = await getAction(actionId);

    if (action.status === 'success') {
      logger.info({ actionId, duration: Date.now() - startTime }, 'Hetzner action completed');
      return;
    }

    if (action.status === 'error') {
      throw new Error(`Hetzner action failed: ${action.error?.message || 'unknown error'}`);
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(`Hetzner action timed out after ${maxWaitMs}ms`);
}

/** Wait for server to reach running state. */
export async function waitForServerRunning(serverId: number, maxWaitMs = 300000): Promise<void> {
  const startTime = Date.now();
  const pollInterval = 2000;

  while (Date.now() - startTime < maxWaitMs) {
    const server = await getServer(serverId);

    if (server.status === 'running') {
      logger.info({ serverId, duration: Date.now() - startTime }, 'Hetzner server is running');
      return;
    }

    if (server.status === 'off' || server.status === 'deleting') {
      throw new Error(`Hetzner server entered unexpected state: ${server.status}`);
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(`Hetzner server failed to start after ${maxWaitMs}ms`);
}
