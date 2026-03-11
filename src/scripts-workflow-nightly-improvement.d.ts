declare module '../scripts/workflow/nightly-improvement.js' {
  export function buildEvaluationKey(sourceKey: string, cursor: string): string;
  export function shouldProcessEvaluation(input: {
    evaluatedKeys: Record<string, unknown>;
    evaluationKey: string;
    sourceKey: string;
    force?: boolean;
    forceSources?: string[];
    forceKeys?: string[];
  }): boolean;
  export function pruneEvaluatedKeys(
    evaluatedKeys: Record<string, { evaluatedAt?: string }>,
  ): Record<string, { evaluatedAt?: string }>;
  export function applyNightlyRecord(
    previousState: {
      schema_version?: number;
      last_run_at?: string | null;
      last_upstream_sha?: string | null;
      tool_versions?: Record<string, string>;
      context_refs?: Record<string, unknown>;
      evaluated_keys?: Record<string, unknown>;
    },
    scan: {
      upstream?: {
        toSha?: string | null;
        pending?: boolean;
        evaluationKey?: string;
      };
      tooling?: {
        currentVersions?: Record<string, string>;
        candidates?: Array<{
          key: string;
          currentVersion: string;
          pending?: boolean;
          evaluationKey?: string;
        }>;
        deferredCandidates?: Array<{
          key: string;
          currentVersion: string;
        }>;
      };
    },
    refs?: {
      upstreamPageId?: string | null;
      upstreamPageUrl?: string | null;
      toolingPageId?: string | null;
      toolingPageUrl?: string | null;
    },
    recordedAt?: string,
  ): {
    schema_version: number;
    last_run_at: string | null;
    last_upstream_sha: string | null;
    tool_versions: Record<string, string>;
    context_refs: Record<string, unknown>;
    evaluated_keys: Record<string, unknown>;
  };
}
