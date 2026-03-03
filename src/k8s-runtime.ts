/**
 * Kubernetes runtime abstraction for NanoClaw.
 * Verifies cluster connectivity and cleans up stale Jobs.
 */
import * as k8s from '@kubernetes/client-node';

import { K8S_NAMESPACE } from './config.js';
import { logger } from './logger.js';

let _kc: k8s.KubeConfig | null = null;

export function getKubeConfig(): k8s.KubeConfig {
  if (!_kc) {
    _kc = new k8s.KubeConfig();
    _kc.loadFromDefault();
  }
  return _kc;
}

/** Verify cluster connectivity by listing pods in the namespace. */
export async function ensureK8sRunning(): Promise<void> {
  const kc = getKubeConfig();
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);
  try {
    await coreApi.listNamespacedPod({ namespace: K8S_NAMESPACE });
    logger.debug('Kubernetes cluster reachable');
  } catch (err) {
    logger.error({ err }, 'Failed to reach Kubernetes cluster');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Kubernetes cluster is not reachable                    ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without a working K8s cluster. To fix:     ║',
    );
    console.error(
      '║  1. Ensure kubectl is configured (kubeconfig / in-cluster)     ║',
    );
    console.error(
      '║  2. Run: kubectl get pods                                      ║',
    );
    console.error(
      '║  3. Restart NanoClaw                                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Kubernetes cluster is required but not reachable');
  }
}

/** Delete stale NanoClaw Jobs left from previous runs. */
export async function cleanupOrphanJobs(): Promise<void> {
  const kc = getKubeConfig();
  const batchApi = kc.makeApiClient(k8s.BatchV1Api);
  try {
    const res = await batchApi.listNamespacedJob({
      namespace: K8S_NAMESPACE,
      labelSelector: 'app=nanoclaw',
    });
    const jobs = res.items ?? [];
    let cleaned = 0;
    for (const job of jobs) {
      const name = job.metadata?.name;
      if (!name) continue;
      // Delete completed or failed jobs (active jobs from a prior crash)
      const succeeded = job.status?.succeeded ?? 0;
      const failed = job.status?.failed ?? 0;
      const active = job.status?.active ?? 0;
      if (succeeded > 0 || failed > 0 || active > 0) {
        try {
          await batchApi.deleteNamespacedJob({
            name,
            namespace: K8S_NAMESPACE,
            body: { propagationPolicy: 'Background' },
          });
          cleaned++;
        } catch {
          /* already gone */
        }
      }
    }
    if (cleaned > 0) {
      logger.info({ count: cleaned }, 'Cleaned up orphaned K8s Jobs');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned K8s Jobs');
  }
}
