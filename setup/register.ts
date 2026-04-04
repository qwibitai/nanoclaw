/**
 * Step: register — Write channel registration config, create group folders.
 *
 * Accepts --channel to specify the messaging platform (whatsapp, telegram, slack, discord).
 * Uses parameterized SQL queries to prevent injection.
 */
import fs from 'fs';
import path from 'path';

import {
  DEFAULT_GLOBAL_MEMORY_TEMPLATE_FINGERPRINT,
  DEFAULT_MAIN_MEMORY_TEMPLATE_FINGERPRINT,
  listManagedMemoryFiles,
  seedGroupMemoryFiles,
} from '../src/agent/memory.ts';
import { STORE_DIR } from '../src/config.ts';
import { initDatabase, setRegisteredGroup } from '../src/db.ts';
import { isValidGroupFolder } from '../src/group-folder.ts';
import { logger } from '../src/logger.ts';
import { emitStatus } from './status.ts';

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

function parseArgs(args: string[]): RegisterArgs {
  const result: RegisterArgs = {
    jid: '',
    name: '',
    trigger: '',
    folder: '',
    channel: 'whatsapp', // backward-compat: pre-refactor installs omit --channel
    requiresTrigger: true,
    isMain: false,
    assistantName: 'Andy',
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
        result.assistantName = args[++i] || 'Andy';
        break;
    }
  }

  return result;
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

  // Initialize database (creates schema + runs migrations)
  initDatabase();

  setRegisteredGroup(parsed.jid, {
    name: parsed.name,
    folder: parsed.folder,
    trigger: parsed.trigger,
    added_at: new Date().toISOString(),
    requiresTrigger: parsed.requiresTrigger,
    isMain: parsed.isMain,
  });

  logger.info('Wrote registration to SQLite');

  // Create group folders
  const groupDir = path.join(projectRoot, 'groups', parsed.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), {
    recursive: true,
  });

  const globalDir = path.join(projectRoot, 'groups', 'global');
  const globalSeededMemory = seedGroupMemoryFiles({
    targetDir: globalDir,
    templateDir: globalDir,
    canonicalTemplateFingerprint: DEFAULT_GLOBAL_MEMORY_TEMPLATE_FINGERPRINT,
  });

  if (globalSeededMemory.canonical.created) {
    logger.info(
      {
        file: globalSeededMemory.canonical.path,
        seededFrom: globalSeededMemory.canonical.seededFrom,
      },
      'Prepared canonical global memory before group registration',
    );
  }

  if (globalSeededMemory.compatibility.created) {
    logger.info(
      {
        file: globalSeededMemory.compatibility.path,
        seededFrom: globalSeededMemory.compatibility.seededFrom,
      },
      'Prepared compatibility global memory before group registration',
    );
  }

  if (globalSeededMemory.migration?.status === 'migrated') {
    logger.info(
      {
        canonicalPath: globalSeededMemory.migration.canonicalPath,
        compatibilityPath: globalSeededMemory.migration.compatibilityPath,
      },
      'Promoted legacy global CLAUDE.md before group registration',
    );
  }

  const templateDir = parsed.isMain
    ? path.join(projectRoot, 'groups', 'main')
    : path.join(projectRoot, 'groups', 'global');
  const seededMemory = seedGroupMemoryFiles({
    targetDir: groupDir,
    templateDir,
    canonicalTemplateFingerprint: parsed.isMain
      ? DEFAULT_MAIN_MEMORY_TEMPLATE_FINGERPRINT
      : undefined,
  });

  if (seededMemory.canonical.created) {
    logger.info(
      {
        file: seededMemory.canonical.path,
        seededFrom: seededMemory.canonical.seededFrom,
      },
      'Created AGENT.md canonical memory',
    );
  }

  if (seededMemory.compatibility.created) {
    logger.info(
      {
        file: seededMemory.compatibility.path,
        seededFrom: seededMemory.compatibility.seededFrom,
      },
      'Created CLAUDE.md compatibility memory',
    );
  }

  if (seededMemory.migration?.status === 'migrated') {
    logger.info(
      {
        canonicalPath: seededMemory.migration.canonicalPath,
        compatibilityPath: seededMemory.migration.compatibilityPath,
      },
      'Promoted legacy CLAUDE.md into canonical AGENT.md during registration',
    );
  }

  // Preserve customized memory files by only seeding missing files.
  // Current runtime flows still read CLAUDE.md, so we materialize that as a
  // compatibility file from the canonical AGENT.md when needed.
  const groupClaudeMdPath = path.join(groupDir, 'CLAUDE.md');
  const groupAgentMdPath = path.join(groupDir, 'AGENT.md');
  logger.debug(
    {
      folder: parsed.folder,
      agentExists: fs.existsSync(groupAgentMdPath),
      claudeExists: fs.existsSync(groupClaudeMdPath),
    },
    'Group memory files ready',
  );

  // Update assistant name in canonical and compatibility memory files if
  // different from the default.
  let nameUpdated = false;
  if (parsed.assistantName !== 'Andy') {
    logger.info(
      { from: 'Andy', to: parsed.assistantName },
      'Updating assistant name',
    );

    const groupsDir = path.join(projectRoot, 'groups');
    const mdFiles = fs
      .readdirSync(groupsDir)
      .flatMap((entry) => listManagedMemoryFiles(path.join(groupsDir, entry)));

    for (const mdFile of mdFiles) {
      let content = fs.readFileSync(mdFile, 'utf-8');
      content = content.replace(/^# Andy$/m, `# ${parsed.assistantName}`);
      content = content.replace(
        /You are Andy/g,
        `You are ${parsed.assistantName}`,
      );
      fs.writeFileSync(mdFile, content);
      logger.info({ file: mdFile }, 'Updated memory file');
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

  emitStatus('REGISTER_CHANNEL', {
    JID: parsed.jid,
    NAME: parsed.name,
    FOLDER: parsed.folder,
    CHANNEL: parsed.channel,
    TRIGGER: parsed.trigger,
    REQUIRES_TRIGGER: parsed.requiresTrigger,
    ASSISTANT_NAME: parsed.assistantName,
    NAME_UPDATED: nameUpdated,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
