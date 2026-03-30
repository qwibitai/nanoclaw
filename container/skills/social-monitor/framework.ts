// container/skills/social-monitor/framework.ts
import path from 'path';
import { DedupStore } from './dedup.js';
import { EngagementLog } from './engagement-log.js';
import { buildDecisionPrompt } from './decision-prompt.js';
import type {
  SocialMonitor,
  MonitorContext,
  EngagementAction,
  EngagementLogEntry,
} from './interfaces.js';

interface FrameworkDeps {
  askClaude: (prompt: string) => Promise<string>;
  requestApproval: (args: {
    requestId: string;
    category: string;
    action: string;
    summary: string;
    details: Record<string, unknown>;
  }) => Promise<{ approved: boolean; respondedBy: string }>;
  syncEngagement: (entries: EngagementLogEntry[]) => void;
}

export async function runMonitorCycle(
  monitor: SocialMonitor,
  ctx: MonitorContext,
  deps: FrameworkDeps,
): Promise<{ actionsExecuted: number; actionsPending: number }> {
  const groupDir = `/workspace/group`;
  const dedupPath = path.join(groupDir, 'seen_items.db');
  const logPath = path.join(groupDir, 'engagement_log.db');

  const dedup = new DedupStore(dedupPath);
  const engLog = new EngagementLog(logPath);

  try {
    // 1. Fetch
    const allItems = await monitor.fetchTimeline(ctx);

    // 2. Filter
    const newItems = dedup.filterUnseen(allItems, monitor.platform);
    if (newItems.length === 0) {
      dedup.prune();
      return { actionsExecuted: 0, actionsPending: 0 };
    }

    // 3. Decide
    const formatted = monitor.formatForDecision(newItems);
    const prompt = buildDecisionPrompt(ctx.personaPath, formatted);
    const response = await deps.askClaude(prompt);

    let decisions: Array<{ itemIndex: number; action: string; content?: string }>;
    try {
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      decisions = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    } catch {
      decisions = [];
    }

    // 4. Act
    let actionsExecuted = 0;
    let actionsPending = 0;

    for (const decision of decisions) {
      const item = newItems[decision.itemIndex];
      if (!item || decision.action === 'ignore') continue;

      const action: EngagementAction = {
        type: decision.action as EngagementAction['type'],
        targetId: item.id,
        targetUrl: item.url,
        targetAuthor: item.author.handle,
        targetContent: item.content,
        content: decision.content,
        approvalCategory: `${monitor.platform}_${decision.action}`,
      };

      const entryId = `${monitor.platform}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const logEntry: EngagementLogEntry = {
        id: entryId,
        platform: monitor.platform,
        actionType: decision.action,
        targetId: item.id,
        targetUrl: item.url,
        targetAuthor: item.author.handle,
        targetContent: item.content.slice(0, 500),
        content: decision.content ?? null,
        approvalId: null,
        status: 'executed',
        triggeredBy: 'monitor',
        createdAt: new Date().toISOString(),
        executedAt: null,
      };

      const approvalId = `apr-${entryId}`;

      try {
        const approvalResult = await deps.requestApproval({
          requestId: approvalId,
          category: action.approvalCategory,
          action: decision.action,
          summary: `${decision.action} ${item.author.handle}: "${item.content.slice(0, 100)}..."`,
          details: { ...action },
        });

        logEntry.approvalId = approvalId;

        if (!approvalResult.approved) {
          logEntry.status = 'rejected';
          engLog.log(logEntry);
          continue;
        }
      } catch {
        logEntry.status = 'failed';
        engLog.log(logEntry);
        continue;
      }

      // Execute the action
      if (ctx.dryRun) {
        logEntry.status = 'executed';
        logEntry.executedAt = new Date().toISOString();
        engLog.log(logEntry);
        dedup.markSeen(item.id, monitor.platform, decision.action);
        actionsExecuted++;
        continue;
      }

      try {
        const result = await monitor.executeAction(action);
        if (result.success) {
          logEntry.status = 'executed';
          logEntry.executedAt = new Date().toISOString();
          actionsExecuted++;
        } else {
          logEntry.status = 'failed';
        }
      } catch {
        logEntry.status = 'failed';
      }

      engLog.log(logEntry);
      dedup.markSeen(item.id, monitor.platform, decision.action);
    }

    // Mark all fetched items as seen (even if ignored)
    for (const item of newItems) {
      if (!dedup.hasSeen(item.id, monitor.platform)) {
        dedup.markSeen(item.id, monitor.platform, 'ignored');
      }
    }

    // 5. Sync
    const toSync = engLog.drainForSync(monitor.platform);
    if (toSync.length > 0) {
      deps.syncEngagement(toSync);
    }

    dedup.prune();
    return { actionsExecuted, actionsPending };
  } finally {
    dedup.close();
    engLog.close();
  }
}
