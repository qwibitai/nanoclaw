import { z } from 'zod';

import type { Agent } from '../api/agent.js';
import type { AgentDb } from '../db.js';

/** Compute the start of the current daily budget period (epoch ms). */
function getDailyPeriodStart(resetHour: number): number {
  const now = new Date();
  const start = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      resetHour,
      0,
      0,
      0,
    ),
  );
  if (start.getTime() > now.getTime()) {
    start.setUTCDate(start.getUTCDate() - 1);
  }
  return start.getTime();
}

export function registerBudgetActions(agent: Agent, db: AgentDb): void {
  // ── budget_set ──────────────────────────────────────────────────

  agent.action(
    'budget_set',
    'Configure the token spending budget for an agent group. Pass null to remove a limit.',
    {
      group_jid: z.string().describe('The group/chat JID to configure'),
      daily_limit_usd: z
        .number()
        .positive()
        .nullable()
        .optional()
        .describe('Daily spend limit in USD. null removes the daily limit.'),
      total_limit_usd: z
        .number()
        .positive()
        .nullable()
        .optional()
        .describe('All-time spend limit in USD. null removes the total limit.'),
      reset_hour: z
        .number()
        .int()
        .min(0)
        .max(23)
        .optional()
        .describe('UTC hour at which the daily counter resets (0–23, default 0).'),
    },
    async (args) => {
      db.setBudgetConfig(args.group_jid, {
        daily_limit_usd: args.daily_limit_usd,
        total_limit_usd: args.total_limit_usd,
        reset_hour: args.reset_hour,
      });
      return { ok: true };
    },
  );

  // ── budget_get ──────────────────────────────────────────────────

  agent.action(
    'budget_get',
    'Query the current budget configuration, pause state, and spending for an agent group.',
    {
      group_jid: z.string().describe('The group/chat JID to query'),
    },
    async (args) => {
      const config = db.getBudgetConfig(args.group_jid);
      const state = db.getBudgetState(args.group_jid);
      const resetHour = config?.reset_hour ?? 0;
      const periodStart = getDailyPeriodStart(resetHour);
      const dailyCostUsd = db.getDailyUsageUsd(args.group_jid, periodStart);
      const totalCostUsd = db.getTotalUsageUsd(args.group_jid);

      const dailyPct =
        config?.daily_limit_usd != null && config.daily_limit_usd > 0
          ? dailyCostUsd / config.daily_limit_usd
          : null;
      const totalPct =
        config?.total_limit_usd != null && config.total_limit_usd > 0
          ? totalCostUsd / config.total_limit_usd
          : null;

      return {
        config: {
          daily_limit_usd: config?.daily_limit_usd ?? null,
          total_limit_usd: config?.total_limit_usd ?? null,
          reset_hour: resetHour,
        },
        state,
        usage: {
          daily_cost_usd: dailyCostUsd,
          total_cost_usd: totalCostUsd,
          daily_pct: dailyPct,
          total_pct: totalPct,
        },
      };
    },
  );

  // ── budget_resume ───────────────────────────────────────────────

  agent.action(
    'budget_resume',
    'Clear the budget-exceeded pause for an agent group, allowing it to run again.',
    {
      group_jid: z.string().describe('The group/chat JID to resume'),
    },
    async (args) => {
      db.clearBudgetPaused(args.group_jid);
      return { ok: true };
    },
  );
}
