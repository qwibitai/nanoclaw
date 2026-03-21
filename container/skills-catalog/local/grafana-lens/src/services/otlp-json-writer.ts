/**
 * OTLP JSON Writer
 *
 * Constructs OTLP ExportMetricsServiceRequest payloads as JSON with custom
 * timestamps and POSTs them to the OTLP HTTP endpoint. This bypasses the
 * OTel SDK (which doesn't expose timestamp control) while using the same
 * wire protocol and collector endpoint.
 *
 * Data flow:
 *   TimestampedSample[] → OTLP JSON (gauge dataPoints with timeUnixNano)
 *     → POST to :4318/v1/metrics → OTel Collector → Mimir → Grafana
 */

// ── Types ────────────────────────────────────────────────────────────

export type OtlpWriterConfig = {
  endpoint: string;
  headers?: Record<string, string>;
};

export type TimestampedSample = {
  metricName: string;
  description?: string;
  labels: Record<string, string>;
  value: number;
  timestampMs: number;
};

// ── OTLP JSON shape (subset we need for gauge writes) ────────────────

type OtlpAttribute = {
  key: string;
  value: { stringValue: string };
};

type OtlpGaugeDataPoint = {
  timeUnixNano: string;
  asDouble: number;
  attributes: OtlpAttribute[];
};

type OtlpMetric = {
  name: string;
  description: string;
  gauge: { dataPoints: OtlpGaugeDataPoint[] };
};

type OtlpExportRequest = {
  resourceMetrics: Array<{
    resource: { attributes: OtlpAttribute[] };
    scopeMetrics: Array<{
      scope: { name: string };
      metrics: OtlpMetric[];
    }>;
  }>;
};

// ── Writer ───────────────────────────────────────────────────────────

export class OtlpJsonWriter {
  private endpoint: string;
  private headers: Record<string, string>;

  constructor(config: OtlpWriterConfig) {
    this.endpoint = config.endpoint;
    this.headers = config.headers ?? {};
  }

  async write(samples: TimestampedSample[]): Promise<void> {
    if (samples.length === 0) return;

    const payload = this.buildPayload(samples);

    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.headers,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `OTLP push failed (HTTP ${res.status}): ${body || res.statusText}`,
      );
    }
  }

  /** Visible for testing. */
  buildPayload(samples: TimestampedSample[]): OtlpExportRequest {
    // Group samples by metric name
    const grouped = new Map<string, TimestampedSample[]>();
    for (const s of samples) {
      let group = grouped.get(s.metricName);
      if (!group) {
        group = [];
        grouped.set(s.metricName, group);
      }
      group.push(s);
    }

    const metrics: OtlpMetric[] = [];
    for (const [name, group] of grouped) {
      metrics.push({
        name,
        description: group[0].description ?? "Custom metric",
        gauge: {
          dataPoints: group.map((s) => ({
            timeUnixNano: msToNanoString(s.timestampMs),
            asDouble: s.value,
            attributes: labelsToAttributes(s.labels),
          })),
        },
      });
    }

    return {
      resourceMetrics: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "openclaw" } },
              { key: "service.namespace", value: { stringValue: "grafana-lens" } },
            ],
          },
          scopeMetrics: [
            {
              scope: { name: "grafana-lens-custom" },
              metrics,
            },
          ],
        },
      ],
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Convert millisecond timestamp to nanosecond string (avoids Number overflow). */
export function msToNanoString(ms: number): string {
  return `${ms}000000`;
}

export function labelsToAttributes(
  labels: Record<string, string>,
): OtlpAttribute[] {
  return Object.entries(labels).map(([key, val]) => ({
    key,
    value: { stringValue: val },
  }));
}
