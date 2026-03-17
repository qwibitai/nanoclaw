import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';
import {
  fetchPageRange,
  indexPdf,
  resolveContainerPath,
  type MountMapping,
} from './pageindex.js';

/**
 * Handle pageindex_fetch and pageindex_index IPC requests from agents.
 *
 * Returns true if the message was handled (even on error), false if the type
 * is not a pageindex_ type.
 */
export async function handlePageindexIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
  isMain: boolean,
  dataDir: string,
  mounts: MountMapping[],
): Promise<boolean> {
  const type = data.type as string;

  if (!type.startsWith('pageindex_')) {
    return false;
  }

  const requestId = data.requestId as string | undefined;
  if (!requestId) {
    logger.warn({ type, sourceGroup }, 'pageindex IPC missing requestId');
    return true;
  }

  const resultsDir = path.join(
    dataDir,
    'ipc',
    sourceGroup,
    'pageindex_results',
  );
  fs.mkdirSync(resultsDir, { recursive: true });

  const writeResult = (result: Record<string, unknown>) => {
    const resultFile = path.join(resultsDir, `${requestId}.json`);
    const tmpFile = `${resultFile}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(result));
    fs.renameSync(tmpFile, resultFile);
  };

  try {
    switch (type) {
      case 'pageindex_fetch': {
        const pdfPath = data.pdfPath as string | undefined;
        const startPage = data.startPage as number | undefined;
        const endPage = data.endPage as number | undefined;

        if (!pdfPath || startPage == null || endPage == null) {
          writeResult({
            success: false,
            error: 'Missing required fields: pdfPath, startPage, endPage',
          });
          break;
        }

        const hostPath = resolveContainerPath(pdfPath, mounts);
        if (!hostPath) {
          writeResult({
            success: false,
            error: `Cannot resolve path: ${pdfPath}`,
          });
          break;
        }

        if (!fs.existsSync(hostPath)) {
          writeResult({
            success: false,
            error: `File not found: ${pdfPath}`,
          });
          break;
        }

        const text = await fetchPageRange(hostPath, startPage, endPage);
        writeResult({ success: true, text });
        break;
      }

      case 'pageindex_index': {
        const pdfPath = data.pdfPath as string | undefined;

        if (!pdfPath) {
          writeResult({
            success: false,
            error: 'Missing required field: pdfPath',
          });
          break;
        }

        const hostPath = resolveContainerPath(pdfPath, mounts);
        if (!hostPath) {
          writeResult({
            success: false,
            error: `Cannot resolve path: ${pdfPath}`,
          });
          break;
        }

        if (!fs.existsSync(hostPath)) {
          writeResult({
            success: false,
            error: `File not found: ${pdfPath}`,
          });
          break;
        }

        const fileName = path.basename(hostPath);
        const vaultDir = path.dirname(hostPath);
        const result = await indexPdf(hostPath, fileName, { vaultDir });

        if (result.success) {
          writeResult({
            success: true,
            tree: result.tree,
            pageCount: result.pageCount,
          });
        } else {
          writeResult({
            success: false,
            error: result.error,
            fallbackText: result.fallbackText,
            pageCount: result.pageCount,
          });
        }
        break;
      }

      default:
        // Unknown pageindex_ subtype
        logger.warn({ type, sourceGroup }, 'Unknown pageindex IPC subtype');
        return false;
    }

    logger.info({ type, requestId, sourceGroup }, 'pageindex IPC handled');
    return true;
  } catch (err) {
    logger.error({ err, type, requestId }, 'pageindex IPC error');
    writeResult({
      success: false,
      error: `Error: ${err instanceof Error ? err.message : String(err)}`,
    });
    return true;
  }
}
