import crypto from "crypto";

import type { Logger } from "pino";

import { TANREN_API_URL } from "../config.js";
import { readEnvFile } from "../env.js";
import { logger as defaultLogger } from "../logger.js";

import { TanrenAPIError, TanrenConnectionError } from "./errors.js";
import type {
  ConfigResponse,
  DispatchAccepted,
  DispatchCancelled,
  DispatchDetail,
  DispatchRequest,
  EventsQuery,
  HealthResponse,
  PaginatedEvents,
  ProvisionRequest,
  ReadinessResponse,
  RunEnvironment,
  RunExecuteAccepted,
  RunFullRequest,
  RunStatus,
  RunTeardownAccepted,
  VMDryRunResult,
  VMHandle,
  VMReleaseConfirmed,
  VMSummary,
} from "./types.js";

export interface TanrenClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  logger?: Logger;
  fetchFn?: typeof fetch;
}

const RETRYABLE_STATUS = new Set([502, 503, 504]);

export class TanrenClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly log: Logger;
  private readonly fetchFn: typeof fetch;

  constructor(options: TanrenClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
    this.log = options.logger ?? defaultLogger;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  // --- Health ---
  async health(): Promise<HealthResponse> {
    return this.request("GET", "/api/v1/health");
  }

  async readiness(): Promise<ReadinessResponse> {
    return this.request("GET", "/api/v1/health/ready");
  }

  // --- Dispatch ---
  async createDispatch(req: DispatchRequest): Promise<DispatchAccepted> {
    return this.request("POST", "/api/v1/dispatch", req);
  }

  async getDispatch(id: string): Promise<DispatchDetail> {
    return this.request("GET", `/api/v1/dispatch/${encodeURIComponent(id)}`);
  }

  async cancelDispatch(id: string): Promise<DispatchCancelled> {
    return this.request("DELETE", `/api/v1/dispatch/${encodeURIComponent(id)}`);
  }

  // --- VM ---
  async listVMs(): Promise<VMSummary[]> {
    return this.request("GET", "/api/v1/vm");
  }

  async provisionVM(req: ProvisionRequest): Promise<VMHandle> {
    return this.request("POST", "/api/v1/vm/provision", req);
  }

  async dryRunVM(req: ProvisionRequest): Promise<VMDryRunResult> {
    return this.request("POST", "/api/v1/vm/dry-run", req);
  }

  async releaseVM(id: string): Promise<VMReleaseConfirmed> {
    return this.request("DELETE", `/api/v1/vm/${encodeURIComponent(id)}`);
  }

  // --- Run ---
  async runProvision(req: ProvisionRequest): Promise<RunEnvironment> {
    return this.request("POST", "/api/v1/run/provision", req);
  }

  async runExecute(envId: string): Promise<RunExecuteAccepted> {
    return this.request("POST", `/api/v1/run/${encodeURIComponent(envId)}/execute`);
  }

  async runTeardown(envId: string): Promise<RunTeardownAccepted> {
    return this.request("POST", `/api/v1/run/${encodeURIComponent(envId)}/teardown`);
  }

  async runStatus(envId: string): Promise<RunStatus> {
    return this.request("GET", `/api/v1/run/${encodeURIComponent(envId)}/status`);
  }

  async runFull(req: RunFullRequest): Promise<DispatchAccepted> {
    return this.request("POST", "/api/v1/run/full", req);
  }

  // --- Config ---
  async getConfig(): Promise<ConfigResponse> {
    return this.request("GET", "/api/v1/config");
  }

  // --- Events ---
  async listEvents(query?: EventsQuery): Promise<PaginatedEvents> {
    let path = "/api/v1/events";
    if (query) {
      const params = new URLSearchParams();
      if (query.workflow_id) params.set("workflow_id", query.workflow_id);
      if (query.event_type) params.set("event_type", query.event_type);
      if (query.limit != null) params.set("limit", String(query.limit));
      if (query.offset != null) params.set("offset", String(query.offset));
      const qs = params.toString();
      if (qs) path += `?${qs}`;
    }
    return this.request("GET", path);
  }

  // --- Core request method ---
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const requestId = crypto.randomUUID();

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const headers: Record<string, string> = {
          "x-api-key": this.apiKey,
          "X-Request-ID": requestId,
        };
        if (body !== undefined) {
          headers["Content-Type"] = "application/json";
        }

        const res = await this.fetchFn(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });

        if (!res.ok) {
          const err = await TanrenAPIError.fromResponse(res, requestId);

          if (RETRYABLE_STATUS.has(res.status) && attempt < this.maxRetries) {
            const delay = this.retryDelayMs * 2 ** attempt * (0.5 + Math.random() * 0.5);
            this.log.warn(
              { status: res.status, attempt, requestId },
              "Tanren API retryable error, retrying",
            );
            await sleep(delay);
            continue;
          }

          throw err;
        }

        return (await res.json()) as T;
      } catch (err) {
        if (err instanceof TanrenAPIError) throw err;

        // Network errors (TypeError from fetch) are retryable
        if (err instanceof TypeError && attempt < this.maxRetries) {
          const delay = this.retryDelayMs * 2 ** attempt * (0.5 + Math.random() * 0.5);
          this.log.warn({ err, attempt, requestId }, "Tanren API network error, retrying");
          await sleep(delay);
          continue;
        }

        // Abort = timeout — do NOT retry
        if (err instanceof DOMException && err.name === "AbortError") {
          throw new TanrenConnectionError(
            `Tanren API request timed out after ${this.timeoutMs}ms`,
            err,
          );
        }

        throw new TanrenConnectionError(
          `Tanren API connection error: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err : new Error(String(err)),
        );
      } finally {
        clearTimeout(timeout);
      }
    }

    // Unreachable — loop always throws or returns. Satisfies TS.
    throw new Error("Unreachable: retry loop exhausted without throwing");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createTanrenClient(overrides?: Partial<TanrenClientOptions>): TanrenClient | null {
  const baseUrl = overrides?.baseUrl ?? TANREN_API_URL;
  if (!baseUrl) return null;

  const apiKey =
    overrides?.apiKey ??
    readEnvFile(["TANREN_API_KEY"]).TANREN_API_KEY ??
    process.env.TANREN_API_KEY;
  if (!apiKey) return null;

  return new TanrenClient({ baseUrl, apiKey, ...overrides });
}
