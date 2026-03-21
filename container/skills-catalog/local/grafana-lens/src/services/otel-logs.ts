/**
 * OTLP Logs Provider
 *
 * Central LoggerProvider lifecycle module. Creates an OpenTelemetry
 * LoggerProvider that pushes structured log records via OTLP HTTP/JSON
 * to the configured collector (LGTM stack, Grafana Cloud, etc.).
 *
 * Mirrors the otel-metrics.ts pattern exactly:
 *   - Local provider only (NO global registration — avoids conflict with diagnostics-otel)
 *   - Fire-and-forget emission via BatchLogRecordProcessor
 *   - Same shared resource identity (service.name=openclaw, service.namespace=grafana-lens)
 *
 * Data flow:
 *   Diagnostic events / tool calls → OTel LogRecord → OTLP exporter → Collector → Loki → Grafana
 */

import type { Logger } from "@opentelemetry/api-logs";
import { SeverityNumber } from "@opentelemetry/api-logs";
import {
  LoggerProvider,
  BatchLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

export { SeverityNumber };

export type OtelLogsConfig = {
  endpoint: string;
  headers?: Record<string, string>;
  serviceVersion?: string;
};

export type OtelLogs = {
  logger: Logger;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
};

const DEFAULT_ENDPOINT = "http://localhost:4318/v1/logs";

export function createOtelLogs(config: OtelLogsConfig): OtelLogs {
  const exporter = new OTLPLogExporter({
    url: config.endpoint || DEFAULT_ENDPOINT,
    headers: config.headers,
  });

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: "openclaw",
    "service.namespace": "grafana-lens",
    ...(config.serviceVersion ? { "service.version": config.serviceVersion } : {}),
  });

  const provider = new LoggerProvider({ resource });
  provider.addLogRecordProcessor(
    new BatchLogRecordProcessor(exporter, {
      scheduledDelayMillis: 5_000,
    }),
  );

  const logger = provider.getLogger("grafana-lens");

  return {
    logger,
    async forceFlush() {
      await provider.forceFlush();
    },
    async shutdown() {
      await provider.shutdown();
    },
  };
}
