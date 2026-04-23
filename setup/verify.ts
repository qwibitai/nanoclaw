/**
 * ステップ: verify — インストール全体のヘルスチェック。
 * 09-verify.sh を置き換えるものです。
 *
 * better-sqlite3 を直接使用し（sqlite3 CLI は不使用）、プラットフォームを考慮したサービスチェックを行います。
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import { STORE_DIR } from '../src/config.js';
import { readEnvFile } from '../src/env.js';
import { logger } from '../src/logger.js';
import {
  getPlatform,
  getServiceManager,
  hasSystemd,
  isRoot,
} from './platform.js';
import { emitStatus } from './status.js';

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const platform = getPlatform();
  const homeDir = os.homedir();

  logger.info('検証を開始します');

  // 1. サービスのステータスを確認
  let service = 'not_found';
  const mgr = getServiceManager();

  if (mgr === 'launchd') {
    try {
      const output = execSync('launchctl list', { encoding: 'utf-8' });
      if (output.includes('com.nanoclaw')) {
        // PID があるか確認（実際に実行中か）
        const line = output.split('\n').find((l) => l.includes('com.nanoclaw'));
        if (line) {
          const pidField = line.trim().split(/\s+/)[0];
          service = pidField !== '-' && pidField ? 'running' : 'stopped';
        }
      }
    } catch {
      // launchctl が利用不可
    }
  } else if (mgr === 'systemd') {
    const prefix = isRoot() ? 'systemctl' : 'systemctl --user';
    try {
      execSync(`${prefix} is-active nanoclaw`, { stdio: 'ignore' });
      service = 'running';
    } catch {
      try {
        const output = execSync(`${prefix} list-unit-files`, {
          encoding: 'utf-8',
        });
        if (output.includes('nanoclaw')) {
          service = 'stopped';
        }
      } catch {
        // systemctl が利用不可
      }
    }
  } else {
    // nohup の PID ファイルを確認
    const pidFile = path.join(projectRoot, 'nanoclaw.pid');
    if (fs.existsSync(pidFile)) {
      try {
        const raw = fs.readFileSync(pidFile, 'utf-8').trim();
        const pid = Number(raw);
        if (raw && Number.isInteger(pid) && pid > 0) {
          process.kill(pid, 0);
          service = 'running';
        }
      } catch {
        service = 'stopped';
      }
    }
  }
  logger.info({ service }, 'サービスステータス');

  // 2. コンテナランタイムを確認
  let containerRuntime = 'none';
  try {
    execSync('command -v container', { stdio: 'ignore' });
    containerRuntime = 'apple-container';
  } catch {
    try {
      execSync('docker info', { stdio: 'ignore' });
      containerRuntime = 'docker';
    } catch {
      // ランタイムなし
    }
  }

  // 3. 認証情報を確認
  let credentials = 'missing';
  const envFile = path.join(projectRoot, '.env');
  if (fs.existsSync(envFile)) {
    const envContent = fs.readFileSync(envFile, 'utf-8');
    if (/^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=/m.test(envContent)) {
      credentials = 'configured';
    }
  }

  // 4. チャネル認証を確認
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);

  const channelAuth: Record<string, string> = {};

  if (process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN) {
    channelAuth.discord = 'configured';
  }

  const configuredChannels = Object.keys(channelAuth);
  const anyChannelConfigured = configuredChannels.length > 0;

  // 5. 登録済みグループを確認（sqlite3 CLI ではなく better-sqlite3 を使用）
  let registeredGroupsCount = 0;
  const dbPath = path.join(STORE_DIR, 'messages.db');
  if (fs.existsSync(dbPath)) {
    try {
      const db = new Database(dbPath, { readonly: true });
      const row = db
        .prepare('SELECT COUNT(*) as count FROM registered_groups')
        .get() as { count: number };
      registeredGroupsCount = row.count;
      db.close();
    } catch {
      // テーブルが存在しない可能性あり
    }
  }

  // 6. マウント許可リストを確認
  let mountAllowlist = 'missing';
  if (
    fs.existsSync(
      path.join(homeDir, '.config', 'nanoclaw', 'mount-allowlist.json'),
    )
  ) {
    mountAllowlist = 'configured';
  }

  // 全体のステータスを決定
  const status =
    service === 'running' &&
    credentials !== 'missing' &&
    anyChannelConfigured &&
    registeredGroupsCount > 0
      ? 'success'
      : 'failed';

  logger.info({ status, channelAuth }, '検証完了');

  emitStatus('VERIFY', {
    SERVICE: service,
    CONTAINER_RUNTIME: containerRuntime,
    CREDENTIALS: credentials,
    CONFIGURED_CHANNELS: configuredChannels.join(','),
    CHANNEL_AUTH: JSON.stringify(channelAuth),
    REGISTERED_GROUPS: registeredGroupsCount,
    MOUNT_ALLOWLIST: mountAllowlist,
    STATUS: status,
    LOG: 'logs/setup.log',
  });

  if (status === 'failed') process.exit(1);
}
