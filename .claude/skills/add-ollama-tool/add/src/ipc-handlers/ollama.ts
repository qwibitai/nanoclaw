/**
 * IPC handler for ollama_status notifications from the container.
 * Logs Ollama activity and fires macOS notifications for generate/done events.
 */

import { exec } from 'child_process';
import os from 'os';
import { logger } from '../logger.js';
import { registerHandler } from './registry.js';

const isMac = os.platform() === 'darwin';

interface OllamaStatus {
  status: 'listing' | 'generating' | 'done';
  detail: string;
  model?: string;
  duration?: number;
  tokens?: number;
}

registerHandler(
  'ollama_status',
  async (params: OllamaStatus) => {
    logger.info(
      {
        ollamaStatus: params.status,
        model: params.model,
        duration: params.duration,
        tokens: params.tokens,
      },
      `Ollama: ${params.detail}`,
    );

    if (!isMac) return { ok: true };

    if (params.status === 'generating') {
      exec(
        `osascript -e 'display notification "${params.detail.replace(/'/g, "'\\''")}" with title "NanoClaw → Ollama" sound name "Submarine"'`,
        () => {},
      );
    } else if (params.status === 'done') {
      exec(
        `osascript -e 'display notification "${params.detail.replace(/'/g, "'\\''")}" with title "NanoClaw ← Ollama ✓" sound name "Glass"'`,
        () => {},
      );
    }

    return { ok: true };
  },
);
