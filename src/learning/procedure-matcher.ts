import {
  findProcedure,
  listProcedures,
  saveProcedure,
  updateProcedureStats,
} from '../memory/procedure-store.js';
import type { Procedure } from '../memory/procedure-store.js';
import { logger } from '../logger.js';

export function checkProcedureMatch(
  message: string,
  groupId: string,
): Procedure | null {
  const words = message.toLowerCase().trim();
  const match = findProcedure(words, groupId);
  if (match) {
    logger.debug({ name: match.name, groupId }, 'Procedure matched');
  }
  return match;
}

export function formatProcedureOffer(procedure: Procedure): string {
  const total = procedure.success_count + procedure.failure_count;
  const rate =
    total > 0 ? Math.floor((procedure.success_count / total) * 100) : 0;
  return (
    `I have a learned procedure for this (${rate}% success rate, ran ${total} times).\n` +
    `Run it? [Yes / Yes, always / No]`
  );
}

export async function executeProcedure(
  procedure: Procedure,
  groupId: string,
  runAgent: (prompt: string) => Promise<'success' | 'error'>,
): Promise<boolean> {
  const stepLines = procedure.steps
    .map((s, i) => `${i + 1}. ${s.details || s.action}`)
    .join('\n');

  const prompt =
    `Execute this exact procedure (learned from prior success):\n${stepLines}\n\n` +
    `Follow these steps precisely. If any step fails, report the failure.`;

  const startMs = Date.now();
  const status = await runAgent(prompt);
  const success = status === 'success';
  const durationMs = Date.now() - startMs;

  updateProcedureStats(procedure.name, success, groupId);

  if (!success) {
    logger.warn(
      { name: procedure.name, groupId },
      'Procedure execution failed',
    );
  } else {
    logger.info(
      { name: procedure.name, groupId, durationMs },
      'Procedure executed',
    );
  }

  return success;
}

export function promoteProcedure(
  name: string,
  trigger: string,
  allGroupIds: string[],
): boolean {
  const matchingGroups: Procedure[] = [];

  for (const gid of allGroupIds) {
    const procs = listProcedures(gid);
    const match = procs.find((p) => p.name === name && p.groupId === gid);
    if (match) matchingGroups.push(match);
  }

  if (matchingGroups.length < 2) return false;

  const existing = findProcedure(trigger, undefined);
  if (existing) return false;

  const merged: Procedure = {
    ...matchingGroups[0],
    success_count: matchingGroups.reduce((s, p) => s + p.success_count, 0),
    failure_count: matchingGroups.reduce((s, p) => s + p.failure_count, 0),
    groupId: undefined,
    updated_at: new Date().toISOString(),
  };
  delete merged.groupId;

  saveProcedure(merged);
  logger.info(
    {
      name,
      fromGroups: matchingGroups.map((p) => p.groupId),
      stepCount: merged.steps.length,
    },
    'Procedure promoted to global scope',
  );
  return true;
}
