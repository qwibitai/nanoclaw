import { logger } from '../logger.js';
import {
  checkProcedureMatch,
  executeProcedure,
  formatProcedureOffer,
} from './procedure-matcher.js';
import { updateProcedureStats } from '../memory/procedure-store.js';

export async function handleMessageWithProcedureCheck(
  message: string,
  groupId: string,
  runAgent: (prompt: string) => Promise<'success' | 'error'>,
  sendMessage: (jid: string, text: string) => Promise<void>,
  enqueueTask: (fn: () => Promise<void>) => void,
): Promise<boolean> {
  const procedure = checkProcedureMatch(message, groupId);
  if (!procedure) return false;

  if (procedure.auto_execute) {
    logger.info({ name: procedure.name, groupId }, 'Auto-executing procedure');
    const success = await executeProcedure(procedure, groupId, runAgent);

    if (!success) {
      if (procedure.groupId) {
        updateProcedureStats(procedure.name, false, procedure.groupId);
      }
      await sendMessage(groupId, 'Learned procedure failed, running normally.');
      enqueueTask(async () => {
        await runAgent(message);
      });
    }
    return true;
  }

  const offer = formatProcedureOffer(procedure);
  await sendMessage(groupId, offer);
  return true;
}
