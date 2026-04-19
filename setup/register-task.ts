/**
 * Step: register-task — Create or update a ScheduledTask in the database.
 *
 * Idempotent: if a task with the given id already exists, it is updated in
 * place rather than rejected. Reads the prompt from a file (--prompt-file)
 * so multi-line content survives shell quoting.
 */
import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';
import { STORE_DIR } from '../src/config.ts';
import { createTask, getTaskById, initDatabase, updateTask } from '../src/db.ts';
import { logger } from '../src/logger.ts';
import { ScheduledTask } from '../src/types.ts';
import { emitStatus } from './status.ts';

interface RegisterTaskArgs {
  id: string;
  groupFolder: string;
  chatJid: string;
  promptFile: string;
  scheduleType: ScheduledTask['schedule_type'];
  scheduleValue: string;
  contextMode: ScheduledTask['context_mode'];
}

function parseArgs(args: string[]): RegisterTaskArgs {
  const result: RegisterTaskArgs = {
    id: '',
    groupFolder: '',
    chatJid: '',
    promptFile: '',
    scheduleType: 'cron',
    scheduleValue: '',
    contextMode: 'isolated',
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--id':
        result.id = args[++i] || '';
        break;
      case '--group-folder':
        result.groupFolder = args[++i] || '';
        break;
      case '--chat-jid':
        result.chatJid = args[++i] || '';
        break;
      case '--prompt-file':
        result.promptFile = args[++i] || '';
        break;
      case '--schedule-type': {
        const raw = (args[++i] || '') as ScheduledTask['schedule_type'];
        result.scheduleType = raw;
        break;
      }
      case '--schedule-value':
        result.scheduleValue = args[++i] || '';
        break;
      case '--context-mode': {
        const raw = (args[++i] || '') as ScheduledTask['context_mode'];
        result.contextMode = raw;
        break;
      }
    }
  }

  return result;
}

function validateScheduleValue(
  scheduleType: ScheduledTask['schedule_type'],
  scheduleValue: string,
): string | null {
  if (scheduleType === 'cron') {
    try {
      CronExpressionParser.parse(scheduleValue);
      return null;
    } catch {
      return `Invalid cron expression: ${scheduleValue}`;
    }
  }

  if (scheduleType === 'interval') {
    const ms = parseInt(scheduleValue, 10);
    if (!ms || ms <= 0) {
      return `Invalid interval value (must be positive integer milliseconds): ${scheduleValue}`;
    }
    return null;
  }

  if (scheduleType === 'once') {
    return null;
  }

  return `Unknown schedule_type: ${scheduleType}`;
}

function computeInitialNextRun(
  scheduleType: ScheduledTask['schedule_type'],
  scheduleValue: string,
): string | null {
  if (scheduleType === 'once') {
    return new Date().toISOString();
  }

  if (scheduleType === 'cron') {
    const interval = CronExpressionParser.parse(scheduleValue);
    return interval.next().toISOString();
  }

  if (scheduleType === 'interval') {
    const ms = parseInt(scheduleValue, 10);
    return new Date(Date.now() + ms).toISOString();
  }

  return null;
}

export async function run(args: string[]): Promise<void> {
  const parsed = parseArgs(args);

  if (
    !parsed.id ||
    !parsed.groupFolder ||
    !parsed.chatJid ||
    !parsed.promptFile ||
    !parsed.scheduleType ||
    !parsed.scheduleValue
  ) {
    emitStatus('REGISTER_TASK', {
      STATUS: 'failed',
      ERROR: 'missing_required_args',
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  if (!['cron', 'interval', 'once'].includes(parsed.scheduleType)) {
    emitStatus('REGISTER_TASK', {
      STATUS: 'failed',
      ERROR: `invalid_schedule_type: ${parsed.scheduleType}`,
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  if (!['group', 'isolated'].includes(parsed.contextMode)) {
    emitStatus('REGISTER_TASK', {
      STATUS: 'failed',
      ERROR: `invalid_context_mode: ${parsed.contextMode}`,
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  const scheduleError = validateScheduleValue(
    parsed.scheduleType,
    parsed.scheduleValue,
  );
  if (scheduleError) {
    emitStatus('REGISTER_TASK', {
      STATUS: 'failed',
      ERROR: scheduleError,
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  const promptFilePath = path.resolve(parsed.promptFile);
  if (!fs.existsSync(promptFilePath)) {
    emitStatus('REGISTER_TASK', {
      STATUS: 'failed',
      ERROR: `prompt_file_not_found: ${promptFilePath}`,
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  const prompt = fs.readFileSync(promptFilePath, 'utf-8').trim();
  if (!prompt) {
    emitStatus('REGISTER_TASK', {
      STATUS: 'failed',
      ERROR: 'prompt_file_is_empty',
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  fs.mkdirSync(STORE_DIR, { recursive: true });
  initDatabase();

  const existing = getTaskById(parsed.id);

  if (existing) {
    logger.info({ taskId: parsed.id }, 'Task already exists — updating');

    updateTask(parsed.id, {
      prompt,
      schedule_type: parsed.scheduleType,
      schedule_value: parsed.scheduleValue,
      next_run: computeInitialNextRun(parsed.scheduleType, parsed.scheduleValue),
      status: 'active',
    });

    emitStatus('REGISTER_TASK', {
      ID: parsed.id,
      GROUP_FOLDER: parsed.groupFolder,
      CHAT_JID: parsed.chatJid,
      SCHEDULE_TYPE: parsed.scheduleType,
      SCHEDULE_VALUE: parsed.scheduleValue,
      CONTEXT_MODE: parsed.contextMode,
      ACTION: 'updated',
      STATUS: 'success',
      LOG: 'logs/setup.log',
    });
    return;
  }

  const now = new Date().toISOString();
  const nextRun = computeInitialNextRun(parsed.scheduleType, parsed.scheduleValue);

  createTask({
    id: parsed.id,
    group_folder: parsed.groupFolder,
    chat_jid: parsed.chatJid,
    prompt,
    script: null,
    schedule_type: parsed.scheduleType,
    schedule_value: parsed.scheduleValue,
    context_mode: parsed.contextMode,
    next_run: nextRun,
    status: 'active',
    created_at: now,
  });

  logger.info({ taskId: parsed.id }, 'Registered scheduled task');

  emitStatus('REGISTER_TASK', {
    ID: parsed.id,
    GROUP_FOLDER: parsed.groupFolder,
    CHAT_JID: parsed.chatJid,
    SCHEDULE_TYPE: parsed.scheduleType,
    SCHEDULE_VALUE: parsed.scheduleValue,
    CONTEXT_MODE: parsed.contextMode,
    ACTION: 'created',
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
