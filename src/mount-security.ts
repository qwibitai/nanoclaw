/**
 * NanoClaw 用マウントセキュリティモジュール
 *
 * プロジェクトルートの「外」にある許可リストに照らして追加マウントを検証します。
 * これにより、コンテナエージェントがセキュリティ設定を変更することを防ぎます。
 *
 * 許可リストの場所: ~/.config/nanoclaw/mount-allowlist.json
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import pino from 'pino';

import { MOUNT_ALLOWLIST_PATH } from './config.js';
import { AdditionalMount, AllowedRoot, MountAllowlist } from './types.js';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

// 許可リストをメモリにキャッシュ - プロセス再起動時にのみ再読み込みされる
let cachedAllowlist: MountAllowlist | null = null;
let allowlistLoadError: string | null = null;

/**
 * デフォルトの拒否パターン - 決してマウントすべきでないパス
 */
const DEFAULT_BLOCKED_PATTERNS = [
  '.ssh',
  '.gnupg',
  '.gpg',
  '.aws',
  '.azure',
  '.gcloud',
  '.kube',
  '.docker',
  'credentials',
  '.env',
  '.netrc',
  '.npmrc',
  '.pypirc',
  'id_rsa',
  'id_ed25519',
  'private_key',
  '.secret',
];

/**
 * 外部設定からマウント許可リストを読み込みます。
 * ファイルが存在しないか不正な場合は null を返します。
 * 結果はプロセスの生存期間中、メモリにキャッシュされます。
 */
export function loadMountAllowlist(): MountAllowlist | null {
  if (cachedAllowlist !== null) {
    return cachedAllowlist;
  }

  if (allowlistLoadError !== null) {
    // すでに試行して失敗しているため、ログを出し続けない
    return null;
  }

  try {
    if (!fs.existsSync(MOUNT_ALLOWLIST_PATH)) {
      allowlistLoadError = `Mount allowlist not found at ${MOUNT_ALLOWLIST_PATH}`;
      logger.warn(
        { path: MOUNT_ALLOWLIST_PATH },
        'Mount allowlist not found - additional mounts will be BLOCKED. ' +
          'Create the file to enable additional mounts.',
      );
      return null;
    }

    const content = fs.readFileSync(MOUNT_ALLOWLIST_PATH, 'utf-8');
    const allowlist = JSON.parse(content) as MountAllowlist;

    // 構造を検証
    if (!Array.isArray(allowlist.allowedRoots)) {
      throw new Error('allowedRoots must be an array');
    }

    if (!Array.isArray(allowlist.blockedPatterns)) {
      throw new Error('blockedPatterns must be an array');
    }

    if (typeof allowlist.nonMainReadOnly !== 'boolean') {
      throw new Error('nonMainReadOnly must be a boolean');
    }

    // デフォルトの拒否パターンとマージ
    const mergedBlockedPatterns = [
      ...new Set([...DEFAULT_BLOCKED_PATTERNS, ...allowlist.blockedPatterns]),
    ];
    allowlist.blockedPatterns = mergedBlockedPatterns;

    cachedAllowlist = allowlist;
    logger.info(
      {
        path: MOUNT_ALLOWLIST_PATH,
        allowedRoots: allowlist.allowedRoots.length,
        blockedPatterns: allowlist.blockedPatterns.length,
      },
      'Mount allowlist loaded successfully',
    );

    return cachedAllowlist;
  } catch (err) {
    allowlistLoadError = err instanceof Error ? err.message : String(err);
    logger.error(
      {
        path: MOUNT_ALLOWLIST_PATH,
        error: allowlistLoadError,
      },
      'Failed to load mount allowlist - additional mounts will be BLOCKED',
    );
    return null;
  }
}

/**
 * ~ をホームディレクトリに展開し、絶対パスに解決します。
 */
function expandPath(p: string): string {
  const homeDir = process.env.HOME || os.homedir();
  if (p.startsWith('~/')) {
    return path.join(homeDir, p.slice(2));
  }
  if (p === '~') {
    return homeDir;
  }
  return path.resolve(p);
}

/**
 * シンボリックリンクを解決して、実際のパスを取得します。
 * パスが存在しない場合は null を返します。
 */
function getRealPath(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * パスがいずれかの拒否パターンに一致するか確認します。
 */
function matchesBlockedPattern(
  realPath: string,
  blockedPatterns: string[],
): string | null {
  const pathParts = realPath.split(path.sep);

  for (const pattern of blockedPatterns) {
    // いずれかのパスコンポーネントがパターンに一致するか確認
    for (const part of pathParts) {
      if (part === pattern || part.includes(pattern)) {
        return pattern;
      }
    }

    // フルパスにパターンが含まれているかも確認
    if (realPath.includes(pattern)) {
      return pattern;
    }
  }

  return null;
}

/**
 * 実際のパスがいずれかの許可されたルート配下にあるか確認します。
 */
function findAllowedRoot(
  realPath: string,
  allowedRoots: AllowedRoot[],
): AllowedRoot | null {
  for (const root of allowedRoots) {
    const expandedRoot = expandPath(root.path);
    const realRoot = getRealPath(expandedRoot);

    if (realRoot === null) {
      // 許可されたルートが存在しない場合はスキップ
      continue;
    }

    // realPath が realRoot 配下にあるか確認
    const relative = path.relative(realRoot, realPath);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
      return root;
    }
  }

  return null;
}

/**
 * /workspace/extra/ からの脱出を防ぐため、コンテナパスを検証します。
 */
function isValidContainerPath(containerPath: string): boolean {
  // パストラバーサルを防ぐため .. を含んではならない
  if (containerPath.includes('..')) {
    return false;
  }

  // 絶対パスであってはならない（/workspace/extra/ が付与されるため）
  if (containerPath.startsWith('/')) {
    return false;
  }

  // 空であってはならない
  if (!containerPath || containerPath.trim() === '') {
    return false;
  }

  return true;
}

export interface MountValidationResult {
  allowed: boolean;
  reason: string;
  realHostPath?: string;
  resolvedContainerPath?: string;
  effectiveReadonly?: boolean;
}

/**
 * 許可リストに照らして単一の追加マウントを検証します。
 * 理由を含めた検証結果を返します。
 */
export function validateMount(
  mount: AdditionalMount,
  isMain: boolean, // true = main または override の特権グループ

): MountValidationResult {
  const allowlist = loadMountAllowlist();

  // 許可リストがない場合は、すべての追加マウントを拒否
  if (allowlist === null) {
    return {
      allowed: false,
      reason: `No mount allowlist configured at ${MOUNT_ALLOWLIST_PATH}`,
    };
  }

  // 指定がない場合は hostPath のベース名から containerPath を導出
  const containerPath = mount.containerPath || path.basename(mount.hostPath);

  // コンテナパスの検証（安価なチェック）
  if (!isValidContainerPath(containerPath)) {
    return {
      allowed: false,
      reason: `Invalid container path: "${containerPath}" - must be relative, non-empty, and not contain ".."`,
    };
  }

  // ホストパスを展開して解決
  const expandedPath = expandPath(mount.hostPath);
  const realPath = getRealPath(expandedPath);

  if (realPath === null) {
    return {
      allowed: false,
      reason: `Host path does not exist: "${mount.hostPath}" (expanded: "${expandedPath}")`,
    };
  }

  // 拒否パターンとの照合
  const blockedMatch = matchesBlockedPattern(
    realPath,
    allowlist.blockedPatterns,
  );
  if (blockedMatch !== null) {
    return {
      allowed: false,
      reason: `Path matches blocked pattern "${blockedMatch}": "${realPath}"`,
    };
  }

  // 許可されたルート配下にあるか確認
  const allowedRoot = findAllowedRoot(realPath, allowlist.allowedRoots);
  if (allowedRoot === null) {
    return {
      allowed: false,
      reason: `Path "${realPath}" is not under any allowed root. Allowed roots: ${allowlist.allowedRoots
        .map((r) => expandPath(r.path))
        .join(', ')}`,
    };
  }

  // 実行時の読み取り専用ステータスを決定
  const requestedReadWrite = mount.readonly === false;
  let effectiveReadonly = true; // デフォルトは読み取り専用

  if (requestedReadWrite) {
    if (!isMain && allowlist.nonMainReadOnly) {
      // メイン以外のグループは強制的に読み取り専用
      effectiveReadonly = true;
      logger.info(
        {
          mount: mount.hostPath,
        },
        'Mount forced to read-only for non-main group',
      );
    } else if (!allowedRoot.allowReadWrite) {
      // ルートが読み書きを許可していない
      effectiveReadonly = true;
      logger.info(
        {
          mount: mount.hostPath,
          root: allowedRoot.path,
        },
        'Mount forced to read-only - root does not allow read-write',
      );
    } else {
      // 読み書きを許可
      effectiveReadonly = false;
    }
  }

  return {
    allowed: true,
    reason: `Allowed under root "${allowedRoot.path}"${allowedRoot.description ? ` (${allowedRoot.description})` : ''}`,
    realHostPath: realPath,
    resolvedContainerPath: containerPath,
    effectiveReadonly,
  };
}

/**
 * グループのすべての追加マウントを検証します。
 * 検証を通過したマウントのみを配列で返します。
 * 拒否されたマウントについては警告ログを出力します。
 */
export function validateAdditionalMounts(
  mounts: AdditionalMount[],
  groupName: string,
  isMain: boolean, // true = main または override の特権グループ

): Array<{
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}> {
  const validatedMounts: Array<{
    hostPath: string;
    containerPath: string;
    readonly: boolean;
  }> = [];

  for (const mount of mounts) {
    const result = validateMount(mount, isMain);

    if (result.allowed) {
      validatedMounts.push({
        hostPath: result.realHostPath!,
        containerPath: `/workspace/extra/${result.resolvedContainerPath}`,
        readonly: result.effectiveReadonly!,
      });

      logger.debug(
        {
          group: groupName,
          hostPath: result.realHostPath,
          containerPath: result.resolvedContainerPath,
          readonly: result.effectiveReadonly,
          reason: result.reason,
        },
        'Mount validated successfully',
      );
    } else {
      logger.warn(
        {
          group: groupName,
          requestedPath: mount.hostPath,
          containerPath: mount.containerPath,
          reason: result.reason,
        },
        'Additional mount REJECTED',
      );
    }
  }

  return validatedMounts;
}

/**
 * ユーザーがカスタマイズするための許可リストのテンプレートファイルを生成します。
 */
export function generateAllowlistTemplate(): string {
  const template: MountAllowlist = {
    allowedRoots: [
      {
        path: '~/projects',
        allowReadWrite: true,
        description: 'Development projects',
      },
      {
        path: '~/repos',
        allowReadWrite: true,
        description: 'Git repositories',
      },
      {
        path: '~/Documents/work',
        allowReadWrite: false,
        description: 'Work documents (read-only)',
      },
    ],
    blockedPatterns: [
      // デフォルト以外の追加パターン
      'password',
      'secret',
      'token',
    ],
    nonMainReadOnly: true,
  };

  return JSON.stringify(template, null, 2);
}
