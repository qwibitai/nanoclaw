/**
 * Grafana HTTP client — self-contained, no external dependencies.
 *
 * Wraps Grafana's REST API for all operations grafana-lens needs:
 * - Dashboards: create, search, get, render, snapshot
 * - Queries: PromQL instant/range via datasource proxy
 * - Alerting: create/list/delete alert rules (Unified Alerting)
 * - Annotations: create/query event markers
 * - Datasources: list, discover metrics/labels
 * - Folders: create/list for organization
 */

export type GrafanaClientOptions = {
  url: string;
  apiKey: string;
  orgId?: number;
};

export type DashboardCreateRequest = {
  dashboard: Record<string, unknown>;
  folderUid?: string;
  message?: string;
  overwrite?: boolean;
};

export type DashboardCreateResponse = {
  id: number;
  uid: string;
  url: string;
  status: string;
  version: number;
};

export type DashboardSearchResult = {
  id: number;
  uid: string;
  title: string;
  url: string;
  type: string;
  tags: string[];
  folderUid?: string;
  folderTitle?: string;
  folderUrl?: string;
};

export type SnapshotCreateResponse = {
  key: string;
  deleteKey: string;
  url: string;
  deleteUrl: string;
  id: number;
};

// ── Datasource types ────────────────────────────────────────────────

export type DatasourceListItem = {
  id: number;
  uid: string;
  name: string;
  type: string;
  url: string;
  isDefault: boolean;
  access: string;
};

// ── Prometheus query types ──────────────────────────────────────────

export type PrometheusInstantResult = {
  status: string;
  data: {
    resultType: string;
    result: Array<{
      metric: Record<string, string>;
      value: [number, string];
    }>;
  };
  /** Non-fatal warnings from Prometheus (e.g., rate() applied to gauge). */
  infos?: string[];
};

export type PrometheusRangeResult = {
  status: string;
  data: {
    resultType: string;
    result: Array<{
      metric: Record<string, string>;
      values: Array<[number, string]>;
    }>;
  };
  /** Non-fatal warnings from Prometheus (e.g., rate() applied to gauge). */
  infos?: string[];
};

export type PrometheusLabelValuesResult = {
  status: string;
  data: string[];
};

// ── Prometheus metadata types ───────────────────────────────────────

export type MetricMetadataItem = { type: string; help: string; unit: string };
export type PrometheusMetadataResult = { status: string; data: Record<string, MetricMetadataItem[]> };

// ── Loki query types ────────────────────────────────────────────────

export type LokiStreamEntry = {
  stream: Record<string, string>;
  values: Array<[string, string]>; // [nanosecond_ts_string, log_line]
};

export type LokiQueryResult = {
  status: string;
  data: {
    resultType: "streams" | "matrix" | "vector";
    result:
      | LokiStreamEntry[]
      | Array<{
          metric: Record<string, string>;
          values?: Array<[number, string]>; // matrix
          value?: [number, string]; // vector
        }>;
    stats?: Record<string, unknown>;
  };
};

// ── Tempo / trace types ─────────────────────────────────────────────

export type TempoAttribute = {
  key: string;
  value: {
    stringValue?: string;
    intValue?: string;
    doubleValue?: number;
    boolValue?: boolean;
    arrayValue?: { values: Array<{ stringValue?: string }> };
  };
};

export type TempoSearchTrace = {
  traceID: string;
  rootServiceName: string;
  rootTraceName: string;
  startTimeUnixNano: string;
  durationMs: number;
  spanSets?: Array<{
    spans: Array<{
      spanID: string;
      startTimeUnixNano: string;
      durationNanos: string;
      attributes?: TempoAttribute[];
    }>;
    matched: number;
  }>;
};

export type TempoSearchResult = {
  traces: TempoSearchTrace[];
};

export type TempoSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  operationName?: string;
  name?: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  status?: { code?: number | string; message?: string };
  attributes?: TempoAttribute[];
  kind?: number | string;
};

export type TempoScopeSpans = {
  scope?: { name?: string; version?: string };
  spans: TempoSpan[];
};

export type TempoResourceSpans = {
  resource?: { attributes?: TempoAttribute[] };
  scopeSpans: TempoScopeSpans[];
};

export type TempoTraceResult = {
  /** OTLP JSON format (some Tempo versions) */
  resourceSpans?: TempoResourceSpans[];
  /** Protobuf-JSON format (Tempo v2 default — uses base64 IDs, string kind/status) */
  batches?: TempoResourceSpans[];
};

// ── Annotation types ────────────────────────────────────────────────

export type AnnotationCreateRequest = {
  dashboardUID?: string;
  panelId?: number;
  time: number;
  timeEnd?: number;
  tags?: string[];
  text: string;
};

export type AnnotationCreateResponse = {
  id: number;
  message: string;
};

export type AnnotationQueryParams = {
  from?: number;
  to?: number;
  dashboardUID?: string;
  panelId?: number;
  tags?: string[];
  limit?: number;
};

export type Annotation = {
  id: number;
  dashboardUID: string;
  panelId: number;
  time: number;
  timeEnd: number;
  tags: string[];
  text: string;
  created: number;
  updated: number;
};

// ── Alert types ─────────────────────────────────────────────────────

export type AlertQuery = {
  refId: string;
  datasourceUid: string;
  model: Record<string, unknown>;
  relativeTimeRange?: { from: number; to: number };
  queryType?: string;
};

export type AlertRuleCreateRequest = {
  title: string;
  folderUID: string;
  ruleGroup: string;
  condition: string;
  data: AlertQuery[];
  for?: string;
  noDataState?: "NoData" | "Alerting" | "OK";
  execErrState?: "Alerting" | "OK" | "Error";
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
};

export type AlertRule = {
  uid: string;
  title: string;
  folderUID: string;
  ruleGroup: string;
  condition: string;
  data: AlertQuery[];
  for: string;
  noDataState: string;
  execErrState: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  updated: string;
  provenance: string;
};

/** Evaluation state for a single alert rule from Grafana's Prometheus-compatible endpoint. */
export type AlertRuleState = {
  uid: string;
  state: "inactive" | "firing" | "pending" | "nodata" | "error";
  health: "ok" | "nodata" | "error" | "unknown";
  lastEvaluation: string;
  evaluationTime: number;
  isPaused: boolean;
};

// ── Folder types ────────────────────────────────────────────────────

export type FolderCreateRequest = {
  title: string;
  uid?: string;
};

export type Folder = {
  id: number;
  uid: string;
  title: string;
  url: string;
};

// ── Contact point types ─────────────────────────────────────────────

export type ContactPoint = {
  uid: string;
  name: string;
  type: string;
  settings: Record<string, unknown>;
  disableResolveMessage: boolean;
};

// ── Contact point create/update types ──────────────────────────────

export type ContactPointCreateRequest = {
  name: string;
  type: string;
  settings: Record<string, unknown>;
  disableResolveMessage?: boolean;
};

// ── Notification policy types ──────────────────────────────────────

export type NotificationPolicyTree = {
  receiver: string;
  group_by?: string[];
  routes?: NotificationPolicyRoute[];
};

export type NotificationPolicyRoute = {
  receiver?: string;
  matchers?: Array<{ name: string; type: string; value: string }>;
  continue?: boolean;
  group_by?: string[];
  routes?: NotificationPolicyRoute[];
};

export class GrafanaClient {
  private baseUrl: string;
  private headers: Record<string, string>;
  private url: string;

  constructor(opts: GrafanaClientOptions) {
    this.baseUrl = opts.url;
    this.url = opts.url;
    this.headers = {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
      ...(opts.orgId ? { "X-Grafana-Org-Id": String(opts.orgId) } : {}),
    };
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 30_000): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error(`Grafana request timed out after ${timeoutMs}ms — is Grafana running at ${this.url}?`);
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Grafana request failed: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Create or update a dashboard.
   * Maps to POST /api/dashboards/db — the same endpoint mcp-grafana's
   * update_dashboard tool calls under the hood.
   */
  async createDashboard(req: DashboardCreateRequest): Promise<DashboardCreateResponse> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/api/dashboards/db`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(req),
    });

    if (!res.ok) {
      const body = await res.text();
      throw this.classifyError("create dashboard", res.status, body);
    }

    return (await res.json()) as DashboardCreateResponse;
  }

  /**
   * Search for dashboards by query string with optional filters.
   */
  async searchDashboards(query: string, opts?: {
    tags?: string[];
    starred?: boolean;
    sort?: string;
    limit?: number;
  }): Promise<DashboardSearchResult[]> {
    const params = new URLSearchParams({ query, type: "dash-db" });
    if (opts?.tags) {
      for (const tag of opts.tags) params.append("tag", tag);
    }
    if (opts?.starred) params.set("starred", "true");
    if (opts?.sort) params.set("sort", opts.sort);
    if (opts?.limit) params.set("limit", String(opts.limit));

    const res = await this.fetchWithTimeout(`${this.baseUrl}/api/search?${params}`, {
      headers: this.headers,
    });

    if (!res.ok) {
      const body = await res.text();
      throw this.classifyError("search dashboards", res.status, body);
    }

    return (await res.json()) as DashboardSearchResult[];
  }

  /**
   * Get a dashboard by UID.
   */
  async getDashboard(uid: string): Promise<Record<string, unknown>> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/api/dashboards/uid/${uid}`, {
      headers: this.headers,
    });

    if (!res.ok) {
      const body = await res.text();
      throw this.classifyError(`get dashboard by uid ${uid}`, res.status, body);
    }

    return (await res.json()) as Record<string, unknown>;
  }

  /**
   * Render a panel as PNG image.
   * Requires the Grafana Image Renderer plugin to be installed.
   *
   * Uses GET /render/d/{uid}?viewPanel={panelId}&kiosk=true
   * (verified from mcp-grafana tools/rendering.go)
   */
  async renderPanel(
    dashboardUid: string,
    panelId: number,
    opts?: {
      width?: number;
      height?: number;
      from?: string;
      to?: string;
      theme?: "light" | "dark";
      scale?: number;
    },
  ): Promise<ArrayBuffer> {
    const params = new URLSearchParams({
      viewPanel: String(panelId),
      kiosk: "true",
      width: String(opts?.width ?? 1000),
      height: String(opts?.height ?? 500),
      from: opts?.from ?? "now-6h",
      to: opts?.to ?? "now",
      theme: opts?.theme ?? "dark",
      scale: String(opts?.scale ?? 1),
    });

    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/render/d/${dashboardUid}?${params}`,
      { headers: this.headers },
      60_000, // Render calls get 60s — image rendering is slow
    );

    if (!res.ok) {
      const body = await res.text();
      throw this.classifyRenderError(dashboardUid, panelId, res.status, body);
    }

    return res.arrayBuffer();
  }

  /**
   * Create a dashboard snapshot.
   * Snapshots freeze the dashboard state at a point in time and provide
   * a shareable URL that works without authentication.
   */
  async createSnapshot(dashboard: Record<string, unknown>, opts?: {
    name?: string;
    expires?: number;
  }): Promise<SnapshotCreateResponse> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/api/snapshots`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        dashboard,
        name: opts?.name,
        expires: opts?.expires,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw this.classifyError("create snapshot", res.status, body);
    }

    return (await res.json()) as SnapshotCreateResponse;
  }

  /** Health check — validates the API key works. */
  async healthCheck(): Promise<boolean> {
    try {
      const res = await this.fetchWithTimeout(`${this.baseUrl}/api/health`, {
        headers: this.headers,
      }, 10_000);
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Returns the full URL for a dashboard by UID. */
  dashboardUrl(uid: string): string {
    return `${this.baseUrl}/d/${uid}`;
  }

  // ── Datasource methods ──────────────────────────────────────────────

  /** List all configured datasources. */
  async listDatasources(): Promise<DatasourceListItem[]> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/api/datasources`, {
      headers: this.headers,
    });

    if (!res.ok) {
      const body = await res.text();
      throw this.classifyError("list datasources", res.status, body);
    }

    return (await res.json()) as DatasourceListItem[];
  }

  // ── Prometheus query methods ────────────────────────────────────────

  /** Run a PromQL instant query against a Prometheus datasource. */
  async queryPrometheus(
    dsUid: string,
    expr: string,
    time?: string,
  ): Promise<PrometheusInstantResult> {
    const params = new URLSearchParams({ query: expr });
    if (time) params.set("time", parseDateMathToSeconds(time));

    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/datasources/proxy/uid/${dsUid}/api/v1/query?${params}`,
      { headers: this.headers },
    );

    if (!res.ok) {
      const body = await res.text();
      throw this.classifyError("query prometheus", res.status, body);
    }

    return (await res.json()) as PrometheusInstantResult;
  }

  /** Run a PromQL range query against a Prometheus datasource. */
  async queryPrometheusRange(
    dsUid: string,
    expr: string,
    start: string,
    end: string,
    step: string,
  ): Promise<PrometheusRangeResult> {
    const params = new URLSearchParams({ query: expr, start: parseDateMathToSeconds(start), end: parseDateMathToSeconds(end), step });

    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/datasources/proxy/uid/${dsUid}/api/v1/query_range?${params}`,
      { headers: this.headers },
    );

    if (!res.ok) {
      const body = await res.text();
      throw this.classifyError("query prometheus range", res.status, body);
    }

    return (await res.json()) as PrometheusRangeResult;
  }

  /** List available metric names from a Prometheus datasource. */
  async listMetricNames(dsUid: string, opts?: { match?: string }): Promise<string[]> {
    const params = new URLSearchParams();
    if (opts?.match) params.append("match[]", opts.match);
    const qs = params.toString();
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/datasources/proxy/uid/${dsUid}/api/v1/label/__name__/values${qs ? `?${qs}` : ""}`,
      { headers: this.headers },
    );

    if (!res.ok) {
      const body = await res.text();
      throw this.classifyError("list metric names", res.status, body);
    }

    const data = (await res.json()) as PrometheusLabelValuesResult;
    return data.data;
  }

  /** List values for a specific label from a Prometheus datasource. */
  async listLabelValues(dsUid: string, label: string): Promise<string[]> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/datasources/proxy/uid/${dsUid}/api/v1/label/${encodeURIComponent(label)}/values`,
      { headers: this.headers },
    );

    if (!res.ok) {
      const body = await res.text();
      throw this.classifyError(`list label values for '${label}'`, res.status, body);
    }

    const data = (await res.json()) as PrometheusLabelValuesResult;
    return data.data;
  }

  /** Get metric metadata (type, help, unit) from a Prometheus datasource. */
  async getMetricMetadata(
    dsUid: string,
    opts?: { limit?: number; metric?: string },
  ): Promise<Record<string, MetricMetadataItem[]>> {
    const params = new URLSearchParams();
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.metric) params.set("metric", opts.metric);

    const qs = params.toString();
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/datasources/proxy/uid/${dsUid}/api/v1/metadata${qs ? `?${qs}` : ""}`,
      { headers: this.headers },
    );

    if (!res.ok) {
      const body = await res.text();
      throw this.classifyError("get metric metadata", res.status, body);
    }

    const data = (await res.json()) as PrometheusMetadataResult;
    return data.data;
  }

  // ── Loki query methods ───────────────────────────────────────────────

  /** Run a LogQL instant query against a Loki datasource. */
  async queryLoki(
    dsUid: string,
    expr: string,
    opts?: { time?: string; limit?: number; direction?: string },
  ): Promise<LokiQueryResult> {
    const params = new URLSearchParams({ query: expr });
    if (opts?.time) params.set("time", parseDateMathToNs(opts.time));
    if (opts?.limit && opts.limit > 0) params.set("limit", String(opts.limit));
    if (opts?.direction) params.set("direction", opts.direction);

    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/datasources/proxy/uid/${dsUid}/loki/api/v1/query?${params}`,
      { headers: this.headers },
    );

    if (!res.ok) {
      const body = await res.text();
      throw this.classifyError("query loki", res.status, body);
    }

    return (await res.json()) as LokiQueryResult;
  }

  /** Run a LogQL range query against a Loki datasource. */
  async queryLokiRange(
    dsUid: string,
    expr: string,
    start: string,
    end: string,
    opts?: { step?: string; limit?: number; direction?: string },
  ): Promise<LokiQueryResult> {
    const params = new URLSearchParams({ query: expr, start: parseDateMathToNs(start), end: parseDateMathToNs(end) });
    if (opts?.step) params.set("step", opts.step);
    if (opts?.limit && opts.limit > 0) params.set("limit", String(opts.limit));
    if (opts?.direction) params.set("direction", opts.direction);

    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/datasources/proxy/uid/${dsUid}/loki/api/v1/query_range?${params}`,
      { headers: this.headers },
    );

    if (!res.ok) {
      const body = await res.text();
      throw this.classifyError("query loki range", res.status, body);
    }

    return (await res.json()) as LokiQueryResult;
  }

  // ── Tempo query methods ──────────────────────────────────────────────

  /** Search traces via TraceQL or basic query parameters. */
  async searchTraces(
    dsUid: string,
    query: string,
    opts?: { start?: string; end?: string; limit?: number; minDuration?: string; maxDuration?: string; spss?: number },
  ): Promise<TempoSearchResult> {
    const params = new URLSearchParams({ q: query });
    if (opts?.start) params.set("start", parseDateMathToSeconds(opts.start));
    if (opts?.end) params.set("end", parseDateMathToSeconds(opts.end));
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.minDuration) params.set("minDuration", opts.minDuration);
    if (opts?.maxDuration) params.set("maxDuration", opts.maxDuration);
    if (opts?.spss) params.set("spss", String(opts.spss));

    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/datasources/proxy/uid/${dsUid}/api/search?${params}`,
      { headers: this.headers },
    );

    if (!res.ok) {
      const body = await res.text();
      throw this.classifyError("search traces", res.status, body);
    }

    return (await res.json()) as TempoSearchResult;
  }

  /** Get a full trace by trace ID. */
  async getTrace(dsUid: string, traceId: string): Promise<TempoTraceResult> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/datasources/proxy/uid/${dsUid}/api/traces/${traceId}`,
      { headers: this.headers },
    );

    if (!res.ok) {
      const body = await res.text();
      throw this.classifyError(`get trace ${traceId}`, res.status, body);
    }

    return (await res.json()) as TempoTraceResult;
  }

  // ── Annotation methods ──────────────────────────────────────────────

  /** Create an annotation on a dashboard or globally. */
  async createAnnotation(req: AnnotationCreateRequest): Promise<AnnotationCreateResponse> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/api/annotations`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(req),
    });

    if (!res.ok) {
      const body = await res.text();
      throw this.classifyError("create annotation", res.status, body);
    }

    return (await res.json()) as AnnotationCreateResponse;
  }

  /** Query annotations with optional filters. */
  async getAnnotations(params: AnnotationQueryParams): Promise<Annotation[]> {
    const qs = new URLSearchParams();
    if (params.from) qs.set("from", String(params.from));
    if (params.to) qs.set("to", String(params.to));
    if (params.dashboardUID) qs.set("dashboardUID", params.dashboardUID);
    if (params.panelId) qs.set("panelId", String(params.panelId));
    if (params.tags) {
      for (const tag of params.tags) qs.append("tags", tag);
    }
    if (params.limit) qs.set("limit", String(params.limit));

    const res = await this.fetchWithTimeout(`${this.baseUrl}/api/annotations?${qs}`, {
      headers: this.headers,
    });

    if (!res.ok) {
      const body = await res.text();
      throw this.classifyError("get annotations", res.status, body);
    }

    return (await res.json()) as Annotation[];
  }

  // ── Alert rule methods ──────────────────────────────────────────────

  /**
   * Create an alert rule via Grafana's Unified Alerting provisioning API.
   * Sends X-Disable-Provenance so agent-created rules remain editable in UI.
   */
  async createAlertRule(req: AlertRuleCreateRequest): Promise<AlertRule> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/v1/provisioning/alert-rules`,
      {
        method: "POST",
        headers: {
          ...this.headers,
          "X-Disable-Provenance": "true",
        },
        body: JSON.stringify(req),
      },
    );

    if (!res.ok) {
      const body = await res.text();
      throw this.classifyError("create alert rule", res.status, body);
    }

    return (await res.json()) as AlertRule;
  }

  /** List all alert rules. */
  async listAlertRules(): Promise<AlertRule[]> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/v1/provisioning/alert-rules`,
      { headers: this.headers },
    );

    if (!res.ok) {
      const body = await res.text();
      throw this.classifyError("list alert rules", res.status, body);
    }

    return (await res.json()) as AlertRule[];
  }

  /** Delete an alert rule by UID. */
  async deleteAlertRule(uid: string): Promise<void> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/v1/provisioning/alert-rules/${uid}`,
      {
        method: "DELETE",
        headers: this.headers,
      },
    );

    if (!res.ok) {
      const body = await res.text();
      throw this.classifyError(`delete alert rule ${uid}`, res.status, body);
    }
  }

  /**
   * Fetch evaluation state for all alert rules via Grafana's Prometheus-compatible endpoint.
   * Returns a map of rule UID → state info for efficient lookup.
   */
  async getAlertRuleStates(): Promise<Map<string, AlertRuleState>> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/prometheus/grafana/api/v1/rules`,
      { headers: this.headers },
    );

    if (!res.ok) {
      const body = await res.text();
      throw this.classifyError("get alert rule states", res.status, body);
    }

    const json = (await res.json()) as {
      data: {
        groups: Array<{
          rules: Array<{
            uid?: string;
            state?: string;
            health?: string;
            lastEvaluation?: string;
            evaluationTime?: number;
            isPaused?: boolean;
          }>;
        }>;
      };
    };

    const stateMap = new Map<string, AlertRuleState>();
    for (const group of json.data?.groups ?? []) {
      for (const rule of group.rules ?? []) {
        if (rule.uid) {
          stateMap.set(rule.uid, {
            uid: rule.uid,
            state: (rule.state ?? "unknown") as AlertRuleState["state"],
            health: (rule.health ?? "unknown") as AlertRuleState["health"],
            lastEvaluation: rule.lastEvaluation ?? "",
            evaluationTime: rule.evaluationTime ?? 0,
            isPaused: rule.isPaused ?? false,
          });
        }
      }
    }
    return stateMap;
  }

  // ── Folder methods ──────────────────────────────────────────────────

  /** Create a folder for organizing dashboards and alert rules. */
  async createFolder(req: FolderCreateRequest): Promise<Folder> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/api/folders`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(req),
    });

    if (!res.ok) {
      const body = await res.text();
      throw this.classifyError("create folder", res.status, body);
    }

    return (await res.json()) as Folder;
  }

  /** List folders. */
  async listFolders(): Promise<Folder[]> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/api/folders?limit=100`, {
      headers: this.headers,
    });

    if (!res.ok) {
      const body = await res.text();
      throw this.classifyError("list folders", res.status, body);
    }

    return (await res.json()) as Folder[];
  }

  // ── Contact point methods ───────────────────────────────────────────

  /** List configured alert contact points. */
  async listContactPoints(): Promise<ContactPoint[]> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/v1/provisioning/contact-points`,
      { headers: this.headers },
    );

    if (!res.ok) {
      const body = await res.text();
      throw this.classifyError("list contact points", res.status, body);
    }

    return (await res.json()) as ContactPoint[];
  }

  /** Create a contact point (webhook, email, etc.). */
  async createContactPoint(req: ContactPointCreateRequest): Promise<ContactPoint> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/v1/provisioning/contact-points`,
      {
        method: "POST",
        headers: {
          ...this.headers,
          "X-Disable-Provenance": "true",
        },
        body: JSON.stringify(req),
      },
    );

    if (!res.ok) {
      const body = await res.text();
      throw this.classifyError("create contact point", res.status, body);
    }

    return (await res.json()) as ContactPoint;
  }

  /** Update an existing contact point by UID. */
  async updateContactPoint(uid: string, req: ContactPointCreateRequest): Promise<void> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/v1/provisioning/contact-points/${uid}`,
      {
        method: "PUT",
        headers: {
          ...this.headers,
          "X-Disable-Provenance": "true",
        },
        body: JSON.stringify(req),
      },
    );

    if (!res.ok) {
      const body = await res.text();
      throw this.classifyError(`update contact point ${uid}`, res.status, body);
    }
  }

  /** Delete a contact point by UID. */
  async deleteContactPoint(uid: string): Promise<void> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/v1/provisioning/contact-points/${uid}`,
      {
        method: "DELETE",
        headers: {
          ...this.headers,
          "X-Disable-Provenance": "true",
        },
      },
    );

    if (!res.ok) {
      const body = await res.text();
      throw this.classifyError(`delete contact point ${uid}`, res.status, body);
    }
  }

  /** Get the notification policy tree. */
  async getNotificationPolicies(): Promise<NotificationPolicyTree> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/v1/provisioning/policies`,
      { headers: this.headers },
    );

    if (!res.ok) {
      const body = await res.text();
      throw this.classifyError("get notification policies", res.status, body);
    }

    return (await res.json()) as NotificationPolicyTree;
  }

  /** Update the full notification policy tree. */
  async updateNotificationPolicies(tree: NotificationPolicyTree): Promise<void> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/v1/provisioning/policies`,
      {
        method: "PUT",
        headers: {
          ...this.headers,
          "X-Disable-Provenance": "true",
        },
        body: JSON.stringify(tree),
      },
    );

    if (!res.ok) {
      const body = await res.text();
      throw this.classifyError("update notification policies", res.status, body);
    }
  }

  // ── Dashboard delete ────────────────────────────────────────────────

  /** Delete a dashboard by UID. */
  async deleteDashboard(uid: string): Promise<{ title: string }> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/dashboards/uid/${uid}`,
      {
        method: "DELETE",
        headers: this.headers,
      },
    );

    if (!res.ok) {
      const body = await res.text();
      throw this.classifyError(`delete dashboard ${uid}`, res.status, body);
    }

    return (await res.json()) as { title: string };
  }

  // ── Alertmanager silence methods ───────────────────────────────────

  /** Create a silence for matching alerts. */
  async createSilence(
    matchers: Array<{ name: string; value: string; isRegex: boolean }>,
    duration: string,
    comment: string,
    createdBy?: string,
  ): Promise<{ silenceID: string }> {
    const now = new Date();
    const durationMs = parseDuration(duration);
    const endsAt = new Date(now.getTime() + durationMs);

    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/alertmanager/grafana/api/v2/silences`,
      {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({
          matchers,
          startsAt: now.toISOString(),
          endsAt: endsAt.toISOString(),
          comment,
          createdBy: createdBy ?? "grafana-lens",
        }),
      },
    );

    if (!res.ok) {
      const body = await res.text();
      throw this.classifyError("create silence", res.status, body);
    }

    return (await res.json()) as { silenceID: string };
  }

  /** List all silences. */
  async listSilences(): Promise<Array<{
    id: string;
    status: { state: string };
    matchers: Array<{ name: string; value: string; isRegex: boolean }>;
    comment: string;
    createdBy: string;
    endsAt: string;
  }>> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/alertmanager/grafana/api/v2/silences`,
      { headers: this.headers },
    );

    if (!res.ok) {
      const body = await res.text();
      throw this.classifyError("list silences", res.status, body);
    }

    return (await res.json()) as Array<{
      id: string;
      status: { state: string };
      matchers: Array<{ name: string; value: string; isRegex: boolean }>;
      comment: string;
      createdBy: string;
      endsAt: string;
    }>;
  }

  /** Delete (expire) a silence by ID. */
  async deleteSilence(silenceId: string): Promise<void> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/alertmanager/grafana/api/v2/silence/${silenceId}`,
      {
        method: "DELETE",
        headers: this.headers,
      },
    );

    if (!res.ok) {
      const body = await res.text();
      throw this.classifyError(`delete silence ${silenceId}`, res.status, body);
    }
  }

  /** Classify render-specific errors with actionable messages. */
  private classifyRenderError(
    uid: string,
    panelId: number,
    status: number,
    body: string,
  ): Error {
    switch (status) {
      case 404:
        return new Error(
          `Panel or dashboard not found (uid: ${uid}, panel: ${panelId})`,
        );
      case 401:
      case 403:
        return new Error(
          "Grafana authentication failed — check your service account token",
        );
      case 502:
        return new Error(
          "Grafana Image Renderer not available — ensure the Image Renderer plugin is installed. See https://grafana.com/docs/grafana/latest/setup-grafana/image-rendering/",
        );
      default:
        return new Error(`Grafana render error ${status}: ${body}`);
    }
  }

  /** Classify general API errors with actionable messages. */
  private classifyError(operation: string, status: number, body: string): Error {
    switch (status) {
      case 401:
      case 403:
        return new Error(
          `Grafana authentication failed — check your service account token (${operation})`,
        );
      case 404:
        return new Error(`Not found: ${operation}`);
      case 409:
        return new Error(`Resource already exists (${operation}) — use a different name or update the existing one`);
      case 422:
        return new Error(`Validation error (${operation}): ${body} — check parameter formats`);
      case 429:
        return new Error(`Rate limited (${operation}) — wait a moment and retry`);
      default:
        return new Error(`Grafana API error ${status} (${operation}): ${body}`);
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Parse a duration string like "2h", "30m", "1d" into milliseconds. */
function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)\s*(s|m|h|d)$/);
  if (!match) {
    // Default: treat as hours
    const n = parseInt(duration, 10);
    return isNaN(n) ? 2 * 60 * 60 * 1000 : n * 60 * 60 * 1000;
  }
  const val = parseInt(match[1], 10);
  switch (match[2]) {
    case "s": return val * 1000;
    case "m": return val * 60 * 1000;
    case "h": return val * 60 * 60 * 1000;
    case "d": return val * 24 * 60 * 60 * 1000;
    default: return val * 60 * 60 * 1000;
  }
}

/**
 * Convert Grafana date math to Unix nanoseconds (for Loki).
 * Accepted: "now", "now-1h", "now-30m", "now-7d", "now-2w",
 *           RFC3339 ("2026-01-15T00:00:00Z"), Unix seconds, Unix nanoseconds.
 * Throws on unrecognized formats with recovery guidance.
 */
export function parseDateMathToNs(time: string): string {
  // Already nanosecond timestamp (16+ digits)
  if (/^\d{16,}$/.test(time)) return time;
  // Unix seconds/ms → convert to ns
  if (/^\d{1,15}(\.\d+)?$/.test(time)) {
    const n = Number(time);
    if (n < 1e12) return String(Math.floor(n * 1e9));       // seconds → ns
    if (n < 1e15) return String(Math.floor(n * 1e6));       // milliseconds → ns
    return String(Math.floor(n));                             // already ns-scale
  }
  // Date math: now, now-Xh, now-Xm, now-Xs, now-Xd, now-Xw
  const match = time.match(/^now(?:-([\d.]+)([smhdw]))?$/);
  if (match) {
    const [, amount, unit] = match;
    let offsetMs = 0;
    if (amount && unit) {
      const n = parseFloat(amount);
      const mult: Record<string, number> = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 };
      offsetMs = n * (mult[unit] ?? 0);
    }
    return String(Math.floor((Date.now() - offsetMs) * 1_000_000));
  }
  // RFC3339 / ISO8601
  const parsed = Date.parse(time);
  if (!isNaN(parsed)) return String(parsed * 1_000_000);
  // No silent fallback — throw with actionable guidance
  throw new Error(
    `Invalid time format '${time}'. Accepted: 'now', 'now-1h', 'now-30m', 'now-7d', Unix seconds (e.g., '1700000000'), or RFC3339 (e.g., '2026-01-15T00:00:00Z').`,
  );
}

/**
 * Convert Grafana date math to Unix seconds (for Prometheus).
 * Same accepted formats as parseDateMathToNs().
 */
export function parseDateMathToSeconds(time: string): string {
  const ns = parseDateMathToNs(time);
  return String(Math.floor(Number(ns) / 1e9));
}

/**
 * Convert Grafana date math to epoch milliseconds (for Annotations API).
 * Same accepted formats as parseDateMathToNs().
 */
export function parseDateMathToMs(time: string): number {
  const ns = parseDateMathToNs(time);
  return Math.floor(Number(ns) / 1_000_000);
}

/** Escape special regex characters in user input for safe use in Prometheus match[] selectors. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
