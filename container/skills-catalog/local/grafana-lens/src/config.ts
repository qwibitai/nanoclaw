/**
 * Grafana Lens plugin configuration types.
 *
 * These mirror the JSON Schema in openclaw.plugin.json but provide
 * TypeScript types for use within the extension code.
 *
 * Config precedence: explicit plugin config > environment variables > defaults.
 * Env vars follow Grafana community conventions (GRAFANA_URL, GRAFANA_SERVICE_ACCOUNT_TOKEN)
 * and OpenTelemetry conventions (OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_HEADERS).
 */

export type GrafanaLensConfig = {
  grafana: {
    url?: string;
    apiKey?: string;
    orgId?: number;
  };
  metrics?: {
    enabled?: boolean;
  };
  otlp?: {
    endpoint?: string;
    headers?: Record<string, string>;
    exportIntervalMs?: number;
    logs?: boolean;
    traces?: boolean;
    captureContent?: boolean;
    contentMaxLength?: number;
    forwardAppLogs?: boolean;
    appLogMinSeverity?: string;
    redactSecrets?: boolean;
  };
  proactive?: {
    enabled?: boolean;
    webhookPath?: string;
    costAlertThreshold?: number;
  };
  customMetrics?: {
    enabled?: boolean;
    maxMetrics?: number;
    maxLabelsPerMetric?: number;
    maxLabelValues?: number;
    defaultTtlDays?: number;
  };
};

/**
 * Validated config with required Grafana credentials resolved.
 * Returned by {@link validateConfig} — safe to use for API calls.
 */
export type ValidatedGrafanaLensConfig = GrafanaLensConfig & {
  grafana: { url: string; apiKey: string };
};

/**
 * Validate that required Grafana credentials are present.
 * Call this at tool/service runtime, NOT during plugin discovery.
 */
export function validateConfig(
  config: GrafanaLensConfig,
): { valid: true; config: ValidatedGrafanaLensConfig } | { valid: false; errors: string[] } {
  const errors: string[] = [];
  if (!config.grafana.url) {
    errors.push(
      "grafana.url is required. Set it in plugin config or via GRAFANA_URL environment variable.",
    );
  }
  if (!config.grafana.apiKey) {
    errors.push(
      "grafana.apiKey is required. Set it in plugin config or via GRAFANA_SERVICE_ACCOUNT_TOKEN environment variable.",
    );
  }
  if (errors.length > 0) {
    return { valid: false, errors };
  }
  return { valid: true, config: config as ValidatedGrafanaLensConfig };
}

/**
 * Derive per-signal OTLP endpoints from a base URL or metrics endpoint.
 *
 * Accepts either a base URL (http://localhost:4318) or a full metrics
 * endpoint (http://localhost:4318/v1/metrics) and returns all three signal paths.
 */
export function deriveOtlpEndpoints(endpoint?: string): {
  metrics: string;
  logs: string;
  traces: string;
} {
  const raw = endpoint ?? "http://localhost:4318/v1/metrics";
  // Strip any /v1/* suffix to get the base collector URL
  const base = raw.replace(/\/v1\/(metrics|logs|traces)\/?$/, "").replace(/\/+$/, "");
  return {
    metrics: `${base}/v1/metrics`,
    logs: `${base}/v1/logs`,
    traces: `${base}/v1/traces`,
  };
}

/**
 * Parse OTEL_EXPORTER_OTLP_HEADERS env var format: "key=value,key2=value2"
 * Returns parsed headers and count of skipped (malformed) pairs.
 */
export function parseOtlpHeadersEnv(raw: string): { headers: Record<string, string>; skipped: number } {
  const headers: Record<string, string> = {};
  let skipped = 0;
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      headers[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
    } else {
      skipped++;
    }
  }
  return { headers, skipped };
}

export function parseConfig(raw?: Record<string, unknown>): GrafanaLensConfig & { _warnings?: string[] } {
  const grafana = (raw?.grafana as Record<string, unknown>) ?? {};

  // Resolve URL: explicit config > GRAFANA_URL env var
  const url = (grafana.url as string) ?? process.env.GRAFANA_URL;
  // Resolve API key: explicit config > GRAFANA_SERVICE_ACCOUNT_TOKEN env var
  const apiKey =
    (grafana.apiKey as string) ?? process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN;

  // Resolve OTLP config: explicit config > OTEL_EXPORTER_OTLP_* env vars > defaults
  const otlpRaw = (raw?.otlp as Record<string, unknown>) ?? {};
  const otlpEndpointEnv = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const otlpHeadersEnv = process.env.OTEL_EXPORTER_OTLP_HEADERS;

  let otlpEndpoint = otlpRaw.endpoint as string | undefined;
  if (!otlpEndpoint && otlpEndpointEnv) {
    // OTEL_EXPORTER_OTLP_ENDPOINT is the base URL; append /v1/metrics for HTTP
    otlpEndpoint = otlpEndpointEnv.replace(/\/+$/, "") + "/v1/metrics";
  }

  let otlpHeaders = otlpRaw.headers as Record<string, string> | undefined;
  let otlpHeadersSkipped = 0;
  if (!otlpHeaders && otlpHeadersEnv) {
    const parsed = parseOtlpHeadersEnv(otlpHeadersEnv);
    otlpHeaders = parsed.headers;
    otlpHeadersSkipped = parsed.skipped;
  }

  const warnings: string[] = [];
  if (otlpHeadersSkipped > 0) {
    warnings.push(
      `OTEL_EXPORTER_OTLP_HEADERS contained ${otlpHeadersSkipped} malformed pair(s) without '=' separator — these were skipped`,
    );
  }

  return {
    grafana: {
      url: url?.replace(/\/+$/, ""),
      apiKey,
      orgId: (grafana.orgId as number) ?? 1,
    },
    metrics: {
      enabled: (raw?.metrics as Record<string, unknown>)?.enabled !== false,
    },
    otlp: {
      endpoint: otlpEndpoint,
      headers: otlpHeaders,
      exportIntervalMs: otlpRaw.exportIntervalMs as number | undefined,
      logs: otlpRaw.logs !== false,
      traces: otlpRaw.traces !== false,
      captureContent: otlpRaw.captureContent !== false,
      contentMaxLength: (otlpRaw.contentMaxLength as number | undefined) ?? 2000,
      forwardAppLogs: otlpRaw.forwardAppLogs !== false,
      appLogMinSeverity: (otlpRaw.appLogMinSeverity as string | undefined) ?? "debug",
      redactSecrets: otlpRaw.redactSecrets !== false,
    },
    proactive: {
      enabled: (raw?.proactive as Record<string, unknown>)?.enabled === true,
      webhookPath:
        ((raw?.proactive as Record<string, unknown>)?.webhookPath as string) ??
        "/grafana-lens/alerts",
      costAlertThreshold:
        ((raw?.proactive as Record<string, unknown>)?.costAlertThreshold as number) ?? 5.0,
    },
    customMetrics: {
      enabled: (raw?.customMetrics as Record<string, unknown>)?.enabled !== false,
      maxMetrics:
        ((raw?.customMetrics as Record<string, unknown>)?.maxMetrics as number) ?? 100,
      maxLabelsPerMetric:
        ((raw?.customMetrics as Record<string, unknown>)?.maxLabelsPerMetric as number) ?? 5,
      maxLabelValues:
        ((raw?.customMetrics as Record<string, unknown>)?.maxLabelValues as number) ?? 50,
      defaultTtlDays:
        (raw?.customMetrics as Record<string, unknown>)?.defaultTtlDays as number | undefined,
    },
    ...(warnings.length > 0 ? { _warnings: warnings } : {}),
  };
}
