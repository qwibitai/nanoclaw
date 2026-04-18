import { logger } from '../logger.js';

export interface HealthStatus {
  healthy: boolean;
  lastCheck: number;
  consecutiveFailures: number;
}

export async function checkSidecarHealth(cdpUrl: string): Promise<boolean> {
  try {
    const url =
      cdpUrl.replace('ws://', 'http://').replace(/\/.*$/, '') + '/json/version';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}

let healthState: HealthStatus = {
  healthy: true,
  lastCheck: 0,
  consecutiveFailures: 0,
};

export function getHealthState(): HealthStatus {
  return { ...healthState };
}

export function resetHealthState(): void {
  healthState = { healthy: true, lastCheck: 0, consecutiveFailures: 0 };
}

export async function runHealthCheck(
  cdpUrl: string,
  onUnhealthy: () => void,
): Promise<HealthStatus> {
  const healthy = await checkSidecarHealth(cdpUrl);
  healthState.lastCheck = Date.now();

  if (healthy) {
    healthState.healthy = true;
    healthState.consecutiveFailures = 0;
  } else {
    healthState.consecutiveFailures++;
    if (healthState.consecutiveFailures >= 3) {
      healthState.healthy = false;
      logger.error(
        { consecutiveFailures: healthState.consecutiveFailures },
        'Browser sidecar unhealthy',
      );
      onUnhealthy();
    }
  }

  return getHealthState();
}
