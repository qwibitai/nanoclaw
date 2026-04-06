/**
 * ステップ: register — チャネル登録設定を書き込み、グループフォルダを作成します。
 *
 * --channel を受け取り、メッセージングプラットフォーム (whatsapp, telegram, slack, discord) を指定します。
 * インジェクションを防ぐため、パラメータ化された SQL クエリを使用します。
 */
import fs from 'fs';
import path from 'path';

import { STORE_DIR } from '../src/config.js';
import { initDatabase, setRegisteredGroup } from '../src/db.js';
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
  type: 'main' | 'chat';
  assistantName: string;
}

function parseArgs(args: string[]): RegisterArgs {
  const result: RegisterArgs = {
    jid: '',
    name: '',
    trigger: '',
    folder: '',
    channel: 'whatsapp', // 後方互換性: リファクタリング前のインストールでは --channel が省略されます
    requiresTrigger: true,
    type: 'chat',
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
        result.type = 'main';
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

  logger.info(parsed, 'チャネルを登録中');

  // data および store ディレクトリが存在することを確認（store/ は WhatsApp 認証をスキップした
  // 新規インストール時には存在しない可能性があります。通常は認証時に作成されます）
  fs.mkdirSync(path.join(projectRoot, 'data'), { recursive: true });
  fs.mkdirSync(STORE_DIR, { recursive: true });

  // データベースを初期化（スキーマ作成 + マイグレーション実行）
  initDatabase();

  setRegisteredGroup(parsed.jid, {
    name: parsed.name,
    folder: parsed.folder,
    trigger: parsed.trigger,
    added_at: new Date().toISOString(),
    requiresTrigger: parsed.requiresTrigger,
    type: parsed.type,
  });

  logger.info('SQLite に登録情報を書き込みました');

  // グループフォルダを作成
  fs.mkdirSync(path.join(projectRoot, 'groups', parsed.folder, 'logs'), {
    recursive: true,
  });

  // デフォルトと異なる場合、CLAUDE.md ファイル内のアシスタント名を更新
  let nameUpdated = false;
  if (parsed.assistantName !== 'Andy') {
    logger.info(
      { from: 'Andy', to: parsed.assistantName },
      'アシスタント名を更新中',
    );

    const mdFiles = [
      path.join(projectRoot, 'groups', 'global', 'CLAUDE.md'),
      path.join(projectRoot, 'groups', parsed.folder, 'CLAUDE.md'),
    ];

    for (const mdFile of mdFiles) {
      if (fs.existsSync(mdFile)) {
        let content = fs.readFileSync(mdFile, 'utf-8');
        content = content.replace(/^# Andy$/m, `# ${parsed.assistantName}`);
        content = content.replace(
          /You are Andy/g,
          `You are ${parsed.assistantName}`,
        );
        fs.writeFileSync(mdFile, content);
        logger.info({ file: mdFile }, 'CLAUDE.md を更新しました');
      }
    }

    // .env を更新
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
    logger.info('.env に ASSISTANT_NAME を設定しました');
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
