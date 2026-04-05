/**
 * OneCLI Cloud integration for Nexus.
 *
 * OneCLI manages service credentials (Discord, Resend, etc.) via its
 * cloud proxy at app.onecli.sh. The Anthropic API key is NOT proxied
 * (latency-sensitive) — it stays in .env.
 *
 * Service channels (Discord, Resend) route their HTTP calls through
 * the OneCLI proxy, which injects credentials and enforces policies.
 */

import { logger } from './logger.ts';

const ONECLI_API_URL = 'https://app.onecli.sh/api';

interface OneCLIAgent {
  id: string;
  name: string;
  identifier: string | null;
  accessToken: string;
  isDefault: boolean;
  secretMode: string;
}

interface OneCLISecret {
  id: string;
  name: string;
  type: string;
  hostPattern: string;
  pathPattern: string;
}

let apiKey: string | undefined;
let defaultAgent: OneCLIAgent | undefined;

/**
 * Initialize OneCLI integration. Call at gateway/worker startup.
 * Returns true if OneCLI Cloud is reachable and configured.
 */
export async function initOneCLI(): Promise<boolean> {
  apiKey =
    Deno.env.get('ONECLI_API_KEY');

  if (!apiKey) {
    logger.info('No ONECLI_API_KEY set — OneCLI integration disabled');
    return false;
  }

  try {
    // Verify connectivity and fetch default agent
    const agents = await onecliGet<OneCLIAgent[]>('/agents');
    defaultAgent = agents.find((a) => a.isDefault);

    if (!defaultAgent) {
      logger.warn('No default OneCLI agent found');
      return false;
    }

    // List configured secrets for logging
    const secrets = await onecliGet<OneCLISecret[]>('/secrets');
    const secretNames = secrets.map((s) => s.name);

    logger.info(
      {
        agent: defaultAgent.name,
        secrets: secretNames,
        secretCount: secrets.length,
      },
      'OneCLI Cloud connected',
    );

    return true;
  } catch (err) {
    logger.warn({ err }, 'OneCLI Cloud unreachable — proxy disabled');
    return false;
  }
}

/**
 * Get the OneCLI proxy URL for routing service HTTP calls.
 * Returns undefined if OneCLI is not initialized.
 *
 * Usage in channel implementations:
 *   const proxyUrl = getProxyUrl();
 *   if (proxyUrl) {
 *     // Set as HTTP_PROXY for this channel's HTTP client
 *   }
 */
export function getProxyUrl(): string | undefined {
  if (!defaultAgent) return undefined;
  // OneCLI Cloud proxy endpoint
  return 'https://proxy.onecli.sh';
}

/**
 * Get the agent access token for Proxy-Authorization header.
 * Service channels include this when routing through the proxy.
 */
export function getAgentToken(): string | undefined {
  return defaultAgent?.accessToken;
}

/**
 * Check if OneCLI is active and ready for proxy routing.
 */
export function isOneCLIActive(): boolean {
  return !!defaultAgent;
}

/**
 * Get OneCLI status for the /api/status endpoint.
 */
export function getOneCLIStatus(): {
  active: boolean;
  agent?: string;
} {
  return {
    active: !!defaultAgent,
    agent: defaultAgent?.name,
  };
}

async function onecliGet<T>(path: string): Promise<T> {
  const res = await fetch(`${ONECLI_API_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
  if (!res.ok) {
    throw new Error(`OneCLI API ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}
