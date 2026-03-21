/**
 * OTLP Traces Provider
 *
 * Central TracerProvider lifecycle module. Creates an OpenTelemetry
 * BasicTracerProvider that pushes trace spans via OTLP HTTP/JSON
 * to the configured collector (LGTM stack, Grafana Cloud, etc.).
 *
 * Mirrors the otel-metrics.ts pattern exactly:
 *   - Local provider only (NO global registration — avoids conflict with diagnostics-otel)
 *   - Fire-and-forget emission via BatchSpanProcessor
 *   - Same shared resource identity (service.name=openclaw, service.namespace=grafana-lens)
 *
 * Data flow:
 *   Diagnostic events / tool calls → OTel Span → OTLP exporter → Collector → Tempo → Grafana
 */

import type { Tracer } from "@opentelemetry/api";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

export { SpanKind, SpanStatusCode };

export type OtelTracesConfig = {
  endpoint: string;
  headers?: Record<string, string>;
  serviceVersion?: string;
};

export type OtelTraces = {
  tracer: Tracer;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
};

const DEFAULT_ENDPOINT = "http://localhost:4318/v1/traces";

export function createOtelTraces(config: OtelTracesConfig): OtelTraces {
  const exporter = new OTLPTraceExporter({
    url: config.endpoint || DEFAULT_ENDPOINT,
    headers: config.headers,
  });

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: "openclaw",
    "service.namespace": "grafana-lens",
    ...(config.serviceVersion ? { "service.version": config.serviceVersion } : {}),
  });

  const provider = new BasicTracerProvider({
    resource,
    spanProcessors: [
      new BatchSpanProcessor(exporter, {
        scheduledDelayMillis: 5_000,
      }),
    ],
  });
  // NO provider.register() — local provider only

  const tracer = provider.getTracer("grafana-lens");

  return {
    tracer,
    async forceFlush() {
      await provider.forceFlush();
    },
    async shutdown() {
      await provider.shutdown();
    },
  };
}
