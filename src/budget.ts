import { getTodaysCost } from './db.js';
import { DAILY_BUDGET_USD } from './config.js';
import { logger } from './logger.js';

export function isBudgetExceeded(): boolean {
  const spent = getTodaysCost();
  if (spent >= DAILY_BUDGET_USD) {
    logger.warn(
      { spent, budget: DAILY_BUDGET_USD },
      'Daily budget exceeded, blocking agent invocation',
    );
    return true;
  }
  return false;
}
