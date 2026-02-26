/**
 * Token usage tracking and periodic reporting.
 * Records usage after each agent invocation and sends a summary to the main group.
 */
import { ContainerOutput } from './container-runner.js';
import { getTokenUsageSince, insertTokenUsage } from './db.js';
import { logger } from './logger.js';

export function recordUsage(
  groupFolder: string,
  usage: ContainerOutput['usage'] | undefined,
  durationMs: number,
): void {
  if (!usage) return;
  try {
    insertTokenUsage({
      group_folder: groupFolder,
      timestamp: new Date().toISOString(),
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_tokens: usage.cache_read_input_tokens ?? 0,
      cache_creation_tokens: usage.cache_creation_input_tokens ?? 0,
      cost_usd: usage.cost_usd ?? null,
      duration_ms: durationMs,
    });
    logger.info(
      {
        group: groupFolder,
        input: usage.input_tokens,
        output: usage.output_tokens,
        cost: usage.cost_usd,
        durationMs,
      },
      'Token usage recorded',
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to record token usage');
  }
}

export function formatUsageSummary(hours: number): string {
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const data = getTokenUsageSince(since);

  if (data.call_count === 0) return '';

  const lines: string[] = [
    `Usage (last ${hours}h) — ${data.call_count} call${data.call_count === 1 ? '' : 's'}`,
    `Tokens: ${data.input_tokens.toLocaleString()} in / ${data.output_tokens.toLocaleString()} out`,
  ];

  if (data.cache_read_tokens > 0 || data.cache_creation_tokens > 0) {
    lines.push(
      `Cache: ${data.cache_read_tokens.toLocaleString()} read / ${data.cache_creation_tokens.toLocaleString()} created`,
    );
  }

  if (data.avg_duration_ms > 0) {
    lines.push(`Duration: avg ${(data.avg_duration_ms / 1000).toFixed(1)}s`);
  }

  if (data.total_cost_usd != null && data.total_cost_usd > 0) {
    lines.push(`Cost: $${data.total_cost_usd.toFixed(3)}`);
  }

  return lines.join('\n');
}

/**
 * Starts a repeating timer that sends a usage report to the main group.
 * Interval controlled by USAGE_REPORT_HOURS env var (default: 6, 0 = disabled).
 * Only sends if there was at least 1 call in the window.
 */
export function startUsageReporter(
  sendMessage: (jid: string, text: string) => Promise<void>,
  getMainJid: () => string | null,
): void {
  const hours = parseFloat(process.env.USAGE_REPORT_HOURS ?? '6');
  if (!hours || hours <= 0) {
    logger.info('Usage reporter disabled (USAGE_REPORT_HOURS=0)');
    return;
  }

  const intervalMs = hours * 3600 * 1000;
  logger.info({ hours }, 'Usage reporter started');

  const report = async () => {
    try {
      const jid = getMainJid();
      if (!jid) {
        logger.debug('Usage reporter: main group JID not found, skipping');
        return;
      }
      const summary = formatUsageSummary(hours);
      if (!summary) {
        logger.debug('Usage reporter: no calls in window, skipping');
        return;
      }
      await sendMessage(jid, summary);
    } catch (err) {
      logger.warn({ err }, 'Usage reporter failed to send');
    }
  };

  setInterval(report, intervalMs);
}
