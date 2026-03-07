/**
 * Step: register — Write channel registration config, create group folders.
 *
 * Accepts --channel to specify the messaging platform (whatsapp, telegram, slack, discord).
 * Uses parameterized SQL queries to prevent injection.
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import {
  HAL_ALLOWED_WHATSAPP_SENDER,
  SENDER_ALLOWLIST_PATH,
  STORE_DIR,
} from '../src/config.js';
import { isValidGroupFolder } from '../src/group-folder.js';
import { logger } from '../src/logger.js';
import { emitStatus } from './status.js';

interface RegisterArgs {
  jid: string;
  name: string;
  trigger: string;
  folder: string;
  channel: string;
  requiresTrigger: boolean;
  isMain: boolean;
  assistantName: string;
}

interface AllowlistEntry {
  allow: '*' | string[];
  mode: 'trigger' | 'drop';
}

interface SenderAllowlistConfig {
  default: AllowlistEntry;
  chats: Record<string, AllowlistEntry>;
  logDenied: boolean;
}

const BASE_ASSISTANT_NAME = 'Andy';
const DEFAULT_ASSISTANT_NAME = 'Hal';

function parseArgs(args: string[]): RegisterArgs {
  const result: RegisterArgs = {
    jid: '',
    name: '',
    trigger: '',
    folder: '',
    channel: 'whatsapp', // backward-compat: pre-refactor installs omit --channel
    requiresTrigger: true,
    isMain: false,
    assistantName: DEFAULT_ASSISTANT_NAME,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--jid':
        result.jid = args[++i] || '';
        break;
      case '--name':
        result.name = args[++i] || '';
        break;
      case '--trigger':
        result.trigger = args[++i] || '';
        break;
      case '--folder':
        result.folder = args[++i] || '';
        break;
      case '--channel':
        result.channel = (args[++i] || '').toLowerCase();
        break;
      case '--no-trigger-required':
        result.requiresTrigger = false;
        break;
      case '--is-main':
        result.isMain = true;
        break;
      case '--assistant-name':
        result.assistantName = args[++i] || DEFAULT_ASSISTANT_NAME;
        break;
    }
  }

  return result;
}

function normalizeWhatsAppSender(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  if (trimmed.endsWith('@s.whatsapp.net')) return trimmed;
  const digits = trimmed.replace(/\D/g, '');
  return digits ? `${digits}@s.whatsapp.net` : trimmed;
}

function loadAllowlistConfig(filePath: string): SenderAllowlistConfig {
  const fallback: SenderAllowlistConfig = {
    default: { allow: '*', mode: 'trigger' },
    chats: {},
    logDenied: true,
  };
  if (!fs.existsSync(filePath)) return fallback;

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
      default?: AllowlistEntry;
      chats?: Record<string, AllowlistEntry>;
      logDenied?: boolean;
    };
    const def = parsed.default;
    const validDefault =
      def &&
      (def.allow === '*' ||
        (Array.isArray(def.allow) &&
          def.allow.every((v) => typeof v === 'string'))) &&
      (def.mode === 'trigger' || def.mode === 'drop');
    if (!validDefault) return fallback;

    return {
      default: def,
      chats:
        parsed.chats && typeof parsed.chats === 'object' ? parsed.chats : {},
      logDenied: parsed.logDenied !== false,
    };
  } catch {
    return fallback;
  }
}

function configureMainSenderAllowlist(mainChatJid: string): string {
  const senderJid = normalizeWhatsAppSender(HAL_ALLOWED_WHATSAPP_SENDER);
  if (!senderJid) return '';

  const config = loadAllowlistConfig(SENDER_ALLOWLIST_PATH);
  config.chats[mainChatJid] = {
    allow: [senderJid],
    mode: 'drop',
  };

  fs.mkdirSync(path.dirname(SENDER_ALLOWLIST_PATH), { recursive: true });
  fs.writeFileSync(
    SENDER_ALLOWLIST_PATH,
    JSON.stringify(config, null, 2) + '\n',
  );
  return senderJid;
}

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const parsed = parseArgs(args);

  if (!parsed.jid || !parsed.name || !parsed.trigger || !parsed.folder) {
    emitStatus('REGISTER_CHANNEL', {
      STATUS: 'failed',
      ERROR: 'missing_required_args',
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  if (!isValidGroupFolder(parsed.folder)) {
    emitStatus('REGISTER_CHANNEL', {
      STATUS: 'failed',
      ERROR: 'invalid_folder',
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  logger.info(parsed, 'Registering channel');

  // Ensure data and store directories exist (store/ may not exist on
  // fresh installs that skip WhatsApp auth, which normally creates it)
  fs.mkdirSync(path.join(projectRoot, 'data'), { recursive: true });
  fs.mkdirSync(STORE_DIR, { recursive: true });

  // Write to SQLite using parameterized queries (no SQL injection)
  const dbPath = path.join(STORE_DIR, 'messages.db');
  const timestamp = new Date().toISOString();
  const requiresTriggerInt = parsed.requiresTrigger ? 1 : 0;

  const db = new Database(dbPath);
  // Ensure schema exists
  db.exec(`CREATE TABLE IF NOT EXISTS registered_groups (
    jid TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    folder TEXT NOT NULL UNIQUE,
    trigger_pattern TEXT NOT NULL,
    added_at TEXT NOT NULL,
    container_config TEXT,
    requires_trigger INTEGER DEFAULT 1,
    is_main INTEGER DEFAULT 0
  )`);

  const isMainInt = parsed.isMain ? 1 : 0;

  db.prepare(
    `INSERT OR REPLACE INTO registered_groups
     (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    parsed.jid,
    parsed.name,
    parsed.folder,
    parsed.trigger,
    timestamp,
    requiresTriggerInt,
    isMainInt,
  );

  db.close();
  logger.info('Wrote registration to SQLite');

  // Create group folders
  fs.mkdirSync(path.join(projectRoot, 'groups', parsed.folder, 'logs'), {
    recursive: true,
  });

  // Update assistant name in CLAUDE.md files if different from default
  let nameUpdated = false;
  if (parsed.assistantName !== BASE_ASSISTANT_NAME) {
    logger.info(
      { from: BASE_ASSISTANT_NAME, to: parsed.assistantName },
      'Updating assistant name',
    );

    const mdFiles = [
      path.join(projectRoot, 'groups', 'global', 'CLAUDE.md'),
      path.join(projectRoot, 'groups', parsed.folder, 'CLAUDE.md'),
    ];

    for (const mdFile of mdFiles) {
      if (fs.existsSync(mdFile)) {
        let content = fs.readFileSync(mdFile, 'utf-8');
        content = content.replace(
          /^# (Andy|Hal)$/m,
          `# ${parsed.assistantName}`,
        );
        content = content.replace(
          /You are (Andy|Hal)/g,
          `You are ${parsed.assistantName}`,
        );
        fs.writeFileSync(mdFile, content);
        logger.info({ file: mdFile }, 'Updated CLAUDE.md');
      }
    }

    // Update .env
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      let envContent = fs.readFileSync(envFile, 'utf-8');
      if (envContent.includes('ASSISTANT_NAME=')) {
        envContent = envContent.replace(
          /^ASSISTANT_NAME=.*$/m,
          `ASSISTANT_NAME="${parsed.assistantName}"`,
        );
      } else {
        envContent += `\nASSISTANT_NAME="${parsed.assistantName}"`;
      }
      fs.writeFileSync(envFile, envContent);
    } else {
      fs.writeFileSync(envFile, `ASSISTANT_NAME="${parsed.assistantName}"\n`);
    }
    logger.info('Set ASSISTANT_NAME in .env');
    nameUpdated = true;
  }

  let allowlistSender = '';
  if (
    parsed.channel === 'whatsapp' &&
    parsed.isMain &&
    !parsed.requiresTrigger &&
    parsed.jid.endsWith('@s.whatsapp.net')
  ) {
    allowlistSender = configureMainSenderAllowlist(parsed.jid);
    if (allowlistSender) {
      logger.info(
        { sender: allowlistSender, path: SENDER_ALLOWLIST_PATH },
        'Configured main-chat sender allowlist for Hal',
      );
    }
  }

  emitStatus('REGISTER_CHANNEL', {
    JID: parsed.jid,
    NAME: parsed.name,
    FOLDER: parsed.folder,
    CHANNEL: parsed.channel,
    TRIGGER: parsed.trigger,
    REQUIRES_TRIGGER: parsed.requiresTrigger,
    ASSISTANT_NAME: parsed.assistantName,
    NAME_UPDATED: nameUpdated,
    SENDER_ALLOWLIST_PATH: allowlistSender ? SENDER_ALLOWLIST_PATH : '',
    SENDER_ALLOWLIST_SENDER: allowlistSender,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
