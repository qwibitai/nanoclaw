/**
 * Lightweight Prometheus metrics registry.
 * No external dependencies — just string formatting for the /metrics endpoint.
 */

interface MetricMeta {
  help: string;
  type: 'counter' | 'gauge';
}

const METRIC_DEFS: Record<string, MetricMeta> = {
  nanoclaw_messages_received_total: {
    help: 'Total messages received from channels',
    type: 'counter',
  },
  nanoclaw_messages_processed_total: {
    help: 'Total messages processed per group',
    type: 'counter',
  },
  nanoclaw_containers_spawned_total: {
    help: 'Total agent containers spawned',
    type: 'counter',
  },
  nanoclaw_container_errors_total: {
    help: 'Total container agent errors',
    type: 'counter',
  },
  nanoclaw_emails_filtered_total: {
    help: 'Total emails filtered by reason',
    type: 'counter',
  },
  nanoclaw_api_requests_total: {
    help: 'Total API proxy requests by status',
    type: 'counter',
  },
  nanoclaw_active_containers: {
    help: 'Number of currently running containers',
    type: 'gauge',
  },
  nanoclaw_registered_groups: {
    help: 'Number of registered groups',
    type: 'gauge',
  },
  nanoclaw_uptime_seconds: {
    help: 'Process uptime in seconds',
    type: 'gauge',
  },
  nanoclaw_circuit_breaker_state: {
    help: 'Circuit breaker state (1 = active for that state)',
    type: 'gauge',
  },
};

// Internal storage: metric name -> labels key -> value
// Labels key is a sorted "k=v,k=v" string for uniqueness
const counters = new Map<string, Map<string, number>>();
const gauges = new Map<string, Map<string, number>>();

function labelsKey(labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) return '';
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}="${labels[k]}"`)
    .join(',');
}

function formatLabels(key: string): string {
  return key ? `{${key}}` : '';
}

export function incCounter(
  name: string,
  labels?: Record<string, string>,
  delta = 1,
): void {
  if (!counters.has(name)) counters.set(name, new Map());
  const key = labelsKey(labels);
  const map = counters.get(name)!;
  map.set(key, (map.get(key) || 0) + delta);
}

export function setGauge(
  name: string,
  value: number,
  labels?: Record<string, string>,
): void {
  if (!gauges.has(name)) gauges.set(name, new Map());
  const key = labelsKey(labels);
  gauges.get(name)!.set(key, value);
}

/**
 * Return all metrics in Prometheus text exposition format.
 */
export function getMetricsText(): string {
  // Set dynamic gauges before rendering
  setGauge('nanoclaw_uptime_seconds', Math.round(process.uptime()));

  const lines: string[] = [];

  for (const [name, meta] of Object.entries(METRIC_DEFS)) {
    const store = meta.type === 'counter' ? counters : gauges;
    const entries = store.get(name);

    lines.push(`# HELP ${name} ${meta.help}`);
    lines.push(`# TYPE ${name} ${meta.type}`);

    if (entries && entries.size > 0) {
      for (const [key, value] of entries) {
        lines.push(`${name}${formatLabels(key)} ${value}`);
      }
    } else {
      // Emit a zero-value default so Prometheus discovers the metric
      if (meta.type === 'counter') {
        lines.push(`${name} 0`);
      }
    }
  }

  return lines.join('\n') + '\n';
}

/** @internal - for tests only */
export function _resetMetricsForTests(): void {
  counters.clear();
  gauges.clear();
}
