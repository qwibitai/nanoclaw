/**
 * Geodesic Workflow Helper
 * =============================================================================
 * Provides utility functions for DayZero agents to update workflow progress
 * in the Geodesic system via GraphQL mutations.
 *
 * Usage:
 *   const helper = new GeodesicWorkflowHelper({
 *     endpoint: 'https://app.geodesicworks.com/gql',
 *     token: 'your-access-token',
 *     tenantId: 'tenant-uuid',
 *   });
 *
 *   await helper.updateWorkflowRun(workflowRunId, {
 *     status: 'running',
 *     progress: 0.5,
 *     currentPhase: 'analysis',
 *     currentTask: 'Processing financial data'
 *   });
 */

import { logger } from './logger.js';

export interface WorkflowUpdateOptions {
  status?: 'queued' | 'running' | 'complete' | 'failed';
  progress?: number;
  currentPhase?: string;
  currentTask?: string;
  errorMessage?: string;
  blobPath?: string;
}

export interface GeodesicWorkflowHelperConfig {
  endpoint: string;
  token: string;
  tenantId: string;
}

export class GeodesicWorkflowHelper {
  private endpoint: string;
  private token: string;
  private tenantId: string;

  constructor(config: GeodesicWorkflowHelperConfig) {
    this.endpoint = config.endpoint;
    this.token = config.token;
    this.tenantId = config.tenantId;
  }

  /**
   * Update workflow run progress in Geodesic
   */
  async updateWorkflowRun(
    workflowRunId: string,
    updates: WorkflowUpdateOptions,
  ): Promise<boolean> {
    const mutation = `
      mutation UpdateWorkflowRun(
        $workflowRunId: UUID!,
        $status: String,
        $progress: Float,
        $currentPhase: String,
        $currentTask: String,
        $errorMessage: String,
        $blobPath: String,
        $startedAt: DateTime,
        $completedAt: DateTime
      ) {
        updateWorkflowRun(
          workflowRunId: $workflowRunId,
          status: $status,
          progress: $progress,
          currentPhase: $currentPhase,
          currentTask: $currentTask,
          errorMessage: $errorMessage,
          blobPath: $blobPath,
          startedAt: $startedAt,
          completedAt: $completedAt
        )
      }
    `;

    const variables: Record<string, unknown> = {
      workflowRunId,
      ...updates,
    };

    // Add timestamps based on status
    if (updates.status === 'running' && !updates.errorMessage) {
      variables.startedAt = new Date().toISOString();
    } else if (updates.status === 'complete' || updates.status === 'failed') {
      variables.completedAt = new Date().toISOString();
    }

    try {
      const resp = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          'X-Tenant-Id': this.tenantId,
        },
        body: JSON.stringify({
          query: mutation,
          variables,
        }),
      });

      if (!resp.ok) {
        const text = await resp.text();
        logger.error(
          { status: resp.status, body: text },
          'Failed to update workflow run',
        );
        return false;
      }

      const data = (await resp.json()) as {
        errors?: unknown[];
        data?: { updateWorkflowRun?: boolean };
      };
      if (data.errors) {
        logger.error({ errors: data.errors }, 'GraphQL errors in workflow update');
        return false;
      }

      logger.info(
        { workflowRunId, updates },
        'Successfully updated workflow run',
      );
      return data.data?.updateWorkflowRun ?? false;
    } catch (err) {
      logger.error({ err, workflowRunId }, 'Exception updating workflow run');
      return false;
    }
  }

  /**
   * Mark workflow as started
   */
  async markStarted(workflowRunId: string, currentTask?: string): Promise<boolean> {
    return this.updateWorkflowRun(workflowRunId, {
      status: 'running',
      progress: 0,
      currentPhase: 'initialization',
      currentTask: currentTask || 'Starting workflow',
    });
  }

  /**
   * Update progress during execution
   */
  async updateProgress(
    workflowRunId: string,
    progress: number,
    currentPhase: string,
    currentTask: string,
  ): Promise<boolean> {
    return this.updateWorkflowRun(workflowRunId, {
      status: 'running',
      progress: Math.max(0, Math.min(1, progress)), // Clamp to [0, 1]
      currentPhase,
      currentTask,
    });
  }

  /**
   * Mark workflow as completed successfully
   */
  async markCompleted(
    workflowRunId: string,
    blobPath?: string,
  ): Promise<boolean> {
    return this.updateWorkflowRun(workflowRunId, {
      status: 'complete',
      progress: 1,
      currentPhase: 'completed',
      currentTask: 'Workflow completed successfully',
      blobPath,
    });
  }

  /**
   * Mark workflow as failed
   */
  async markFailed(
    workflowRunId: string,
    errorMessage: string,
  ): Promise<boolean> {
    return this.updateWorkflowRun(workflowRunId, {
      status: 'failed',
      currentPhase: 'error',
      currentTask: 'Workflow failed',
      errorMessage,
    });
  }
}

/**
 * Create a workflow helper from environment variables
 * Reads GEODESIC_ENDPOINT, GEODESIC_TOKEN, and GEODESIC_DATA_TENANT
 */
export function createWorkflowHelperFromEnv(): GeodesicWorkflowHelper | null {
  const endpoint = process.env.GEODESIC_ENDPOINT;
  const token = process.env.GEODESIC_TOKEN;
  const tenantId = process.env.GEODESIC_DATA_TENANT;

  if (!endpoint || !token || !tenantId) {
    logger.warn(
      'Missing Geodesic environment variables for workflow helper. ' +
        'Set GEODESIC_ENDPOINT, GEODESIC_TOKEN, and GEODESIC_DATA_TENANT.',
    );
    return null;
  }

  return new GeodesicWorkflowHelper({ endpoint, token, tenantId });
}
