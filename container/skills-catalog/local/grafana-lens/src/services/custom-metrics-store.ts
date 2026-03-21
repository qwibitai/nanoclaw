/**
 * Custom Metrics Store
 *
 * Manages dynamic OTel ObservableGauge/Counter instances registered at runtime
 * by the agent via the grafana_push_metrics tool. Provides:
 *
 *   - Validation: name regex, label consistency, cardinality limits
 *   - Persistence: gauge values survive restarts (JSON file in stateDir)
 *   - TTL eviction: optional auto-expiry for stale metrics
 *
 * All metric names are enforced to start with `openclaw_ext_` to prevent
 * collision with built-in `openclaw_lens_*` metrics.
 *
 * Data flow:
 *   Agent pushes data → store updates value maps → OTel ObservableGauge callbacks
 *   read values at export time → OTLP push → Collector → Mimir → Grafana
 */

import type { Meter, Counter as OtelCounter } from "@opentelemetry/api";
import type { OtlpJsonWriter, TimestampedSample } from "./otlp-json-writer.js";

// ── Types ────────────────────────────────────────────────────────────

export type MetricType = "gauge" | "counter";

export type CustomMetricDefinition = {
  name: string;
  type: MetricType;
  help: string;
  labelNames: string[];
  createdAt: number;
  updatedAt: number;
  ttlMs?: number;
};

export type CustomMetricDataPoint = {
  name: string;
  value: number;
  labels?: Record<string, string>;
  type?: MetricType;
  help?: string;
  ttlDays?: number;
  /** ISO 8601 timestamp for historical data (e.g., "2025-01-15"). Omit for real-time. */
  timestamp?: string;
};

export type CustomMetricsLimits = {
  maxMetrics?: number;
  maxLabelsPerMetric?: number;
  maxLabelValues?: number;
};

export type PushResult = {
  accepted: number;
  rejected: Array<{ name: string; reason: string }>;
  /** Mapping of normalized metric name → exact PromQL name (counters get _total suffix). */
  queryNames: Record<string, string>;
};

// ── Persistence shape ────────────────────────────────────────────────

type PersistedState = {
  version: 1;
  metrics: Array<CustomMetricDefinition & { gaugeValues?: Array<{ labels: Record<string, string>; value: number }> }>;
};

// ── Validation ───────────────────────────────────────────────────────

const METRIC_NAME_RE = /^openclaw_ext_[a-zA-Z_][a-zA-Z0-9_]*$/;
const LABEL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const PREFIX = "openclaw_ext_";

function validateMetricName(name: string): string | null {
  if (!METRIC_NAME_RE.test(name)) {
    return `Invalid metric name '${name}'. Must match /^openclaw_ext_[a-zA-Z_][a-zA-Z0-9_]*$/ (no hyphens, dots, or spaces)`;
  }
  return null;
}

function validateLabelName(label: string): string | null {
  if (!LABEL_NAME_RE.test(label)) {
    return `Invalid label name '${label}'. Must match /^[a-zA-Z_][a-zA-Z0-9_]*$/ (no hyphens or colons)`;
  }
  return null;
}

export function normalizeMetricName(name: string): { normalized: string; wasAutoPrepended: boolean } {
  if (name.startsWith(PREFIX)) {
    return { normalized: name, wasAutoPrepended: false };
  }
  return { normalized: `${PREFIX}${name}`, wasAutoPrepended: true };
}

/** Get the exact PromQL name for a metric — counters get `_total` suffix per Prometheus convention. */
export function getPromQLName(name: string, type: MetricType): string {
  return type === "counter" && !name.endsWith("_total") ? `${name}_total` : name;
}

// ── Store ────────────────────────────────────────────────────────────

type Logger = { info(msg: string): void; warn(msg: string): void; error(msg: string): void };

export class CustomMetricsStore {
  private meter: Meter;
  private forceFlushFn: () => Promise<void>;
  private stateDir: string;
  private logger: Logger;
  private limits: Required<CustomMetricsLimits>;
  private definitions = new Map<string, CustomMetricDefinition>();
  /** Gauge value store: metricName → serializedLabels → value */
  private gaugeValues = new Map<string, Map<string, number>>();
  /** OTel Counter instances for counter-type metrics */
  private counters = new Map<string, OtelCounter>();
  private labelValueCounts = new Map<string, Set<string>>();
  private flushInterval: NodeJS.Timeout | null = null;
  /** Set of metric names that have had ObservableGauge registered */
  private registeredGaugeNames = new Set<string>();
  private otlpWriter: OtlpJsonWriter | null;
  private pushCounter: OtelCounter | null;

  constructor(
    meter: Meter,
    forceFlush: () => Promise<void>,
    stateDir: string,
    logger: Logger,
    limits?: CustomMetricsLimits,
    otlpWriter?: OtlpJsonWriter | null,
    pushCounter?: OtelCounter | null,
  ) {
    this.meter = meter;
    this.forceFlushFn = forceFlush;
    this.stateDir = stateDir;
    this.logger = logger;
    this.limits = {
      maxMetrics: limits?.maxMetrics ?? 100,
      maxLabelsPerMetric: limits?.maxLabelsPerMetric ?? 5,
      maxLabelValues: limits?.maxLabelValues ?? 50,
    };
    this.otlpWriter = otlpWriter ?? null;
    this.pushCounter = pushCounter ?? null;
  }

  // ── Persistence ──────────────────────────────────────────────────

  async load(): Promise<void> {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const filePath = path.join(this.stateDir, "custom-metrics.json");

    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const state = JSON.parse(raw) as PersistedState;

      if (state.version !== 1 || !Array.isArray(state.metrics)) {
        this.logger.warn("grafana-lens: custom-metrics.json has unexpected format — starting empty");
        return;
      }

      for (const entry of state.metrics) {
        try {
          this.registerMetric({
            name: entry.name,
            type: entry.type,
            help: entry.help,
            labelNames: entry.labelNames,
            ttlMs: entry.ttlMs,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
          });

          // Restore gauge values from persisted state
          if (entry.type === "gauge" && entry.gaugeValues) {
            const valueMap = this.gaugeValues.get(entry.name);
            if (valueMap) {
              for (const gv of entry.gaugeValues) {
                const key = serializeLabels(gv.labels);
                valueMap.set(key, gv.value);
                this.trackLabelValues(entry.name, gv.labels);
              }
            }
          }
        } catch (err) {
          this.logger.warn(`grafana-lens: skipping persisted metric '${entry.name}': ${err}`);
        }
      }

      this.logger.info(`grafana-lens: restored ${this.definitions.size} custom metrics from disk`);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      this.logger.warn(`grafana-lens: could not load custom-metrics.json — starting empty: ${err}`);
    }
  }

  async flush(): Promise<void> {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const filePath = path.join(this.stateDir, "custom-metrics.json");
    const tmpPath = `${filePath}.tmp`;

    // Evict expired metrics before persisting
    this.evictExpired();

    const metrics: PersistedState["metrics"] = [];
    for (const def of this.definitions.values()) {
      const entry: PersistedState["metrics"][number] = { ...def };

      // Persist gauge values from in-memory map
      if (def.type === "gauge") {
        const valueMap = this.gaugeValues.get(def.name);
        if (valueMap && valueMap.size > 0) {
          entry.gaugeValues = [];
          for (const [key, value] of valueMap) {
            entry.gaugeValues.push({
              labels: deserializeLabels(key),
              value,
            });
          }
        }
      }

      metrics.push(entry);
    }

    const state: PersistedState = { version: 1, metrics };

    try {
      await fs.mkdir(this.stateDir, { recursive: true });
      await fs.writeFile(tmpPath, JSON.stringify(state, null, 2), "utf-8");
      await fs.rename(tmpPath, filePath);
    } catch (err) {
      this.logger.error(`grafana-lens: failed to persist custom metrics: ${err}`);
    }
  }

  startPeriodicFlush(): void {
    this.flushInterval = setInterval(() => {
      void this.flush();
    }, 60_000);
  }

  async stopPeriodicFlush(): Promise<void> {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    await this.flush();
  }

  // ── Registration ─────────────────────────────────────────────────

  registerMetric(def: {
    name: string;
    type: MetricType;
    help: string;
    labelNames: string[];
    ttlMs?: number;
    createdAt?: number;
    updatedAt?: number;
  }): CustomMetricDefinition {
    // Validate name
    const nameErr = validateMetricName(def.name);
    if (nameErr) throw new Error(nameErr);

    // Validate label names
    for (const ln of def.labelNames) {
      const labelErr = validateLabelName(ln);
      if (labelErr) throw new Error(labelErr);
    }

    if (def.labelNames.length > this.limits.maxLabelsPerMetric) {
      throw new Error(
        `Too many labels for metric '${def.name}': ${def.labelNames.length} (max ${this.limits.maxLabelsPerMetric})`,
      );
    }

    // Check for existing metric with same name
    const existing = this.definitions.get(def.name);
    if (existing) {
      if (existing.type !== def.type) {
        throw new Error(
          `Metric '${def.name}' already registered as ${existing.type}, cannot re-register as ${def.type}`,
        );
      }
      // Idempotent — update timestamp
      existing.updatedAt = Date.now();
      return existing;
    }

    // Check capacity
    if (this.definitions.size >= this.limits.maxMetrics) {
      throw new Error(
        `Maximum custom metrics reached (${this.limits.maxMetrics}). Delete unused metrics first.`,
      );
    }

    // Create OTel instrument
    const now = Date.now();
    if (def.type === "gauge") {
      // Initialize value map
      this.gaugeValues.set(def.name, new Map());

      // Register ObservableGauge with callback reading from value map
      if (!this.registeredGaugeNames.has(def.name)) {
        const name = def.name;
        const valueMapRef = this.gaugeValues;
        this.meter.createObservableGauge(name, {
          description: def.help,
        }).addCallback((result) => {
          const vMap = valueMapRef.get(name);
          if (vMap) {
            for (const [key, value] of vMap) {
              result.observe(value, deserializeLabels(key));
            }
          }
        });
        this.registeredGaugeNames.add(name);
      }
    } else {
      const counter = this.meter.createCounter(def.name, {
        description: def.help,
      });
      this.counters.set(def.name, counter);
    }

    const definition: CustomMetricDefinition = {
      name: def.name,
      type: def.type,
      help: def.help,
      labelNames: [...def.labelNames],
      createdAt: def.createdAt ?? now,
      updatedAt: def.updatedAt ?? now,
      ttlMs: def.ttlMs,
    };

    this.definitions.set(def.name, definition);
    return definition;
  }

  // ── Push ─────────────────────────────────────────────────────────

  pushValues(points: CustomMetricDataPoint[]): PushResult {
    const acceptedIndices: number[] = [];
    const rejected: Array<{ name: string; reason: string }> = [];
    const queryNames: Record<string, string> = {};

    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      try {
        this.pushSingleValue(point);
        acceptedIndices.push(i);

        // Build queryNames for accepted metrics
        const { normalized } = normalizeMetricName(point.name);
        const def = this.definitions.get(normalized);
        if (def) {
          queryNames[normalized] = getPromQLName(normalized, def.type);
        }
      } catch (err) {
        rejected.push({
          name: point.name,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { accepted: acceptedIndices.length, rejected, queryNames };
  }

  /**
   * Force an immediate OTLP export so pushed data is available right away.
   */
  async forceFlush(): Promise<void> {
    await this.forceFlushFn();
  }

  /**
   * Record push statistics for the `openclaw_lens_custom_metrics_pushed_total` counter.
   */
  trackPush(accepted: number, rejected: number): void {
    if (!this.pushCounter) return;
    if (accepted > 0) this.pushCounter.add(accepted, { status: "accepted" });
    if (rejected > 0) this.pushCounter.add(rejected, { status: "rejected" });
  }

  /**
   * Validate and normalize a data point: value check, name normalization,
   * auto-registration, label validation, cardinality check.
   * Returns { normalized, labels, def } on success, throws on failure.
   */
  private validateAndNormalize(point: CustomMetricDataPoint): {
    normalized: string;
    labels: Record<string, string>;
    def: CustomMetricDefinition;
  } {
    if (!Number.isFinite(point.value)) {
      throw new Error(`Value must be a finite number, got: ${point.value}`);
    }

    const { normalized } = normalizeMetricName(point.name);
    const labels = point.labels ?? {};

    // Auto-register if not exists
    if (!this.definitions.has(normalized)) {
      this.registerMetric({
        name: normalized,
        type: point.type ?? "gauge",
        help: point.help ?? "Custom metric",
        labelNames: Object.keys(labels),
        ttlMs: point.ttlDays ? point.ttlDays * 86_400_000 : undefined,
      });
    }

    const def = this.definitions.get(normalized)!;

    // Validate labels match registered labelNames
    const providedKeys = Object.keys(labels).sort();
    const expectedKeys = [...def.labelNames].sort();
    if (providedKeys.length !== expectedKeys.length || !providedKeys.every((k, i) => k === expectedKeys[i])) {
      const missing = expectedKeys.filter((k) => !providedKeys.includes(k));
      const extra = providedKeys.filter((k) => !expectedKeys.includes(k));
      const parts: string[] = [];
      if (missing.length) parts.push(`missing: [${missing.join(", ")}]`);
      if (extra.length) parts.push(`unexpected: [${extra.join(", ")}]`);
      throw new Error(
        `Label mismatch for metric '${normalized}'. Declared: [${expectedKeys.join(", ")}]. ${parts.join(", ")}. To change labels, delete the metric first then re-register with the new label set.`,
      );
    }

    this.checkCardinality(normalized, labels);

    return { normalized, labels, def };
  }

  private pushSingleValue(point: CustomMetricDataPoint): void {
    const { normalized, labels, def } = this.validateAndNormalize(point);

    // Update the metric
    if (def.type === "gauge") {
      const valueMap = this.gaugeValues.get(normalized);
      if (!valueMap) throw new Error(`Internal error: gauge value map for '${normalized}' not found`);
      const key = serializeLabels(labels);
      valueMap.set(key, point.value);
    } else {
      if (point.value < 0) {
        throw new Error(`Counter values must be >= 0. Use type 'gauge' for metrics that decrease.`);
      }
      const counter = this.counters.get(normalized);
      if (!counter) throw new Error(`Internal error: counter '${normalized}' not found`);
      counter.add(point.value, labels);
    }

    def.updatedAt = Date.now();
    this.trackLabelValues(normalized, labels);
  }

  // ── Timestamped push ──────────────────────────────────────────────

  async pushTimestampedValues(points: CustomMetricDataPoint[]): Promise<PushResult> {
    if (!this.otlpWriter) {
      throw new Error("Timestamped push requires OtlpJsonWriter — ensure OTLP is configured");
    }

    const accepted: TimestampedSample[] = [];
    const rejected: Array<{ name: string; reason: string }> = [];
    const queryNames: Record<string, string> = {};

    for (const point of points) {
      try {
        // Counters with timestamps break rate() calculations
        const type = point.type ?? "gauge";
        if (type === "counter") {
          throw new Error(
            "Timestamped pushes only support gauge type — counters with arbitrary timestamps break rate() calculations. Use type 'gauge' for historical data.",
          );
        }

        // Parse timestamp
        const ts = new Date(point.timestamp!);
        if (isNaN(ts.getTime())) {
          throw new Error(
            `Invalid timestamp '${point.timestamp}'. Use ISO 8601 format (e.g., '2025-01-15' or '2025-01-15T10:30:00Z').`,
          );
        }

        // Validate and register (reuses all existing validation)
        const { normalized, labels, def } = this.validateAndNormalize(point);

        // Guard against pre-existing counters (point.type may be omitted)
        if (def.type === "counter") {
          throw new Error(
            "Timestamped pushes only support gauge type — counters with arbitrary timestamps break rate() calculations. Use type 'gauge' for historical data.",
          );
        }

        accepted.push({
          metricName: normalized,
          description: def.help,
          labels,
          value: point.value,
          timestampMs: ts.getTime(),
        });

        queryNames[normalized] = getPromQLName(normalized, def.type);
        def.updatedAt = Date.now();
        this.trackLabelValues(normalized, labels);
      } catch (err) {
        rejected.push({
          name: point.name,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Sort chronologically to prevent self-inflicted out-of-order within a batch
    // (Prometheus/Mimir silently drop out-of-order samples exceeding out_of_order_time_window)
    accepted.sort((a, b) => a.timestampMs - b.timestampMs);

    // Write all accepted samples in one OTLP request
    if (accepted.length > 0) {
      await this.otlpWriter.write(accepted);
    }

    return { accepted: accepted.length, rejected, queryNames };
  }

  // ── List / Delete ────────────────────────────────────────────────

  listMetrics(): CustomMetricDefinition[] {
    this.evictExpired();
    return [...this.definitions.values()];
  }

  deleteMetric(name: string): boolean {
    const { normalized } = normalizeMetricName(name);
    const def = this.definitions.get(normalized);
    if (!def) return false;

    // Clear value maps so ObservableGauge callback reports nothing (instrument stays registered but inert)
    this.definitions.delete(normalized);
    this.gaugeValues.delete(normalized);
    this.counters.delete(normalized);
    this.labelValueCounts.delete(normalized);
    return true;
  }

  // ── Cardinality tracking ─────────────────────────────────────────

  private trackLabelValues(name: string, labels: Record<string, string>): void {
    if (Object.keys(labels).length === 0) return;
    const key = serializeLabels(labels);
    let set = this.labelValueCounts.get(name);
    if (!set) {
      set = new Set();
      this.labelValueCounts.set(name, set);
    }
    set.add(key);
  }

  private checkCardinality(name: string, labels: Record<string, string>): void {
    if (Object.keys(labels).length === 0) return;
    const key = serializeLabels(labels);
    const set = this.labelValueCounts.get(name);
    if (set && !set.has(key) && set.size >= this.limits.maxLabelValues) {
      throw new Error(
        `Cardinality limit reached for metric '${name}': ${set.size} unique label combinations (max ${this.limits.maxLabelValues})`,
      );
    }
  }

  // ── TTL eviction ─────────────────────────────────────────────────

  private evictExpired(): void {
    const now = Date.now();
    for (const [name, def] of this.definitions) {
      if (def.ttlMs && now - def.updatedAt > def.ttlMs) {
        this.deleteMetric(name);
        this.logger.info(`grafana-lens: evicted expired custom metric '${name}'`);
      }
    }
  }
}

// ── Label serialization helpers ────────────────────────────────────

function serializeLabels(labels: Record<string, string>): string {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(labels).sort()) {
    sorted[key] = labels[key];
  }
  return JSON.stringify(sorted);
}

function deserializeLabels(key: string): Record<string, string> {
  return JSON.parse(key) as Record<string, string>;
}
