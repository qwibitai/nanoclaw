/**
 * Ecosystem service health checker.
 *
 * Maintains a registry of ecosystem services and checks each one's
 * /health endpoint, measuring latency and capturing status.
 */

export interface ServiceEntry {
  name: string;
  url: string;
  /** Set true to skip health checks (e.g. no health endpoint). */
  skip?: boolean;
  skipReason?: string;
}

export type ServiceStatus = 'up' | 'down' | 'timeout';

export interface ServiceCheckResult {
  name: string;
  url: string;
  status: ServiceStatus;
  latencyMs: number | null;
  error?: string;
  skipped?: boolean;
  skipReason?: string;
}

export interface EcosystemHealthSnapshot {
  timestamp: string;
  results: ServiceCheckResult[];
  summary: { up: number; down: number; timeout: number; skipped: number };
}

/**
 * Registry of ecosystem services to monitor.
 * Each entry specifies the service name and its health endpoint URL.
 */
export const SERVICE_REGISTRY: ServiceEntry[] = [
  { name: 'ai-proxy', url: 'https://ai-proxy-api.jeffreykeyser.net/health' },
  {
    name: 'prompt-registry',
    url: 'https://prompt-api.jeffreykeyser.net/health',
  },
  {
    name: 'solo-vault',
    url: 'https://api.vault.jeffreykeyser.net/health',
  },
  { name: 'cron-service', url: 'https://cron.jeffreykeyser.net/health' },
  { name: 'ping', url: 'https://ping.jeffreykeyser.net/health' },
  {
    name: 'ping-mobile',
    url: '',
    skip: true,
    skipReason: 'no health endpoint',
  },
  { name: 'travel-map', url: 'https://travel-map.jeffreykeyser.net/health' },
  { name: 'flights', url: 'https://flights.jeffreykeyser.net/health' },
  {
    name: 'image-studio',
    url: 'https://image-studio.jeffreykeyser.net/health',
  },
  { name: 'pantry', url: 'http://localhost:3052/health' },
  { name: 'pay', url: 'https://pay.jeffreykeyser.net/health' },
  {
    name: 'analytics-pulse',
    url: 'https://analytics-pulse.jeffreykeyser.net/health',
  },
  {
    name: 'music-store',
    url: 'https://music-store.jeffreykeyser.net/health',
  },
  {
    name: 'jeffreykeyser.net',
    url: 'https://jeffreykeyser.net/health',
  },
  {
    name: 'feedback-registry',
    url: 'https://feedback-registry.jeffreykeyser.net/health',
  },
  { name: 'agency-hq', url: 'http://localhost:3040/api/v1/health' },
  { name: 'qa-patrol', url: 'https://qa-patrol.jeffreykeyser.net/health' },
  { name: 'nof1', url: 'https://nof1.jeffreykeyser.net/health' },
  { name: 'life', url: 'https://life.jeffreykeyser.net/health' },
  { name: 'struct', url: 'https://struct.jeffreykeyser.net/health' },
  {
    name: 'beelink-deploy',
    url: 'https://beelink-deploy.jeffreykeyser.net/health',
  },
  {
    name: 'openclaw-bridge',
    url: 'https://openclaw-bridge.jeffreykeyser.net/health',
  },
];

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Check a single service's health endpoint.
 */
export async function checkService(
  entry: ServiceEntry,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ServiceCheckResult> {
  if (entry.skip) {
    return {
      name: entry.name,
      url: entry.url || '(none)',
      status: 'down',
      latencyMs: null,
      skipped: true,
      skipReason: entry.skipReason,
    };
  }

  const start = performance.now();
  try {
    const response = await fetch(entry.url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Math.round(performance.now() - start);

    if (response.ok) {
      return { name: entry.name, url: entry.url, status: 'up', latencyMs };
    }

    return {
      name: entry.name,
      url: entry.url,
      status: 'down',
      latencyMs,
      error: `HTTP ${response.status}`,
    };
  } catch (err: unknown) {
    const latencyMs = Math.round(performance.now() - start);

    if (isTimeoutError(err)) {
      return {
        name: entry.name,
        url: entry.url,
        status: 'timeout',
        latencyMs,
        error: `timeout after ${timeoutMs}ms`,
      };
    }

    const message = err instanceof Error ? err.message : String(err);
    return {
      name: entry.name,
      url: entry.url,
      status: 'down',
      latencyMs,
      error: message,
    };
  }
}

function isTimeoutError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'TimeoutError') return true;
  if (err instanceof Error && err.name === 'AbortError') return true;
  return false;
}

/**
 * Check all registered ecosystem services and return a snapshot.
 */
export async function checkEcosystemHealth(
  services: ServiceEntry[] = SERVICE_REGISTRY,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<EcosystemHealthSnapshot> {
  const results = await Promise.all(
    services.map((s) => checkService(s, timeoutMs)),
  );

  const summary = { up: 0, down: 0, timeout: 0, skipped: 0 };
  for (const r of results) {
    if (r.skipped) {
      summary.skipped++;
    } else if (r.status === 'up') {
      summary.up++;
    } else if (r.status === 'timeout') {
      summary.timeout++;
    } else {
      summary.down++;
    }
  }

  return { timestamp: new Date().toISOString(), results, summary };
}

/**
 * Format the health snapshot as a plain-text table.
 */
export function formatHealthTable(
  snapshot: EcosystemHealthSnapshot,
  verbose: boolean = false,
): string {
  const lines: string[] = [];
  const useColor = process.stdout.isTTY ?? false;

  const reset = useColor ? '\x1b[0m' : '';
  const bold = useColor ? '\x1b[1m' : '';
  const green = useColor ? '\x1b[32m' : '';
  const red = useColor ? '\x1b[31m' : '';
  const yellow = useColor ? '\x1b[33m' : '';
  const dim = useColor ? '\x1b[2m' : '';

  lines.push('');
  lines.push(`${bold}Ecosystem Health Check${reset}`);
  lines.push(`${dim}${snapshot.timestamp}${reset}`);
  lines.push('');

  // Column widths
  const nameW = 22;
  const urlW = 52;
  const statusW = 12;
  const latencyW = 10;

  const header =
    padRight('Service', nameW) +
    padRight('URL', urlW) +
    padRight('Status', statusW) +
    padRight('Latency', latencyW);
  lines.push(header);
  lines.push('\u2500'.repeat(nameW + urlW + statusW + latencyW));

  for (const r of snapshot.results) {
    let statusIcon: string;
    if (r.skipped) {
      statusIcon = `${dim}\u2212 skip${reset}`;
    } else if (r.status === 'up') {
      statusIcon = `${green}\u2713 up${reset}`;
    } else if (r.status === 'timeout') {
      statusIcon = `${yellow}\u23f1 timeout${reset}`;
    } else {
      statusIcon = `${red}\u2717 down${reset}`;
    }

    const latencyStr =
      r.latencyMs !== null ? `${r.latencyMs}ms` : `${dim}-${reset}`;
    const displayUrl = truncate(r.url, urlW - 2);

    lines.push(
      padRight(r.name, nameW) +
        padRight(displayUrl, urlW) +
        padRight(statusIcon, statusW + (useColor ? 9 : 0)) +
        latencyStr,
    );

    if (verbose && r.error) {
      lines.push(`${dim}  \u2514\u2500 ${r.error}${reset}`);
    }
  }

  lines.push('');
  const { up, down, timeout, skipped } = snapshot.summary;
  const total = snapshot.results.length - skipped;
  lines.push(
    `${bold}Summary:${reset} ${green}${up}/${total} up${reset}` +
      (down > 0 ? `, ${red}${down} down${reset}` : '') +
      (timeout > 0 ? `, ${yellow}${timeout} timeout${reset}` : '') +
      (skipped > 0 ? `, ${dim}${skipped} skipped${reset}` : ''),
  );
  lines.push('');

  return lines.join('\n');
}

function padRight(str: string, width: number): string {
  return str.length >= width ? str : str + ' '.repeat(width - str.length);
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '\u2026';
}
