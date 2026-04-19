import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, SECURITY_POLICY_PATH } from './config.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';

// --- Types ---

export interface SecurityPolicy {
  trust: { owner_ids: string[]; trusted_members: string[] };
  tools: { blocked: string[]; blocked_untrusted: string[] };
  bash: {
    blocked_patterns: string[];
    blocked_env_vars: string[];
    blocked_url_patterns: string[];
  };
  webfetch: {
    https_only: boolean;
    blocked_networks: string[];
    blocked_url_patterns: string[];
    block_secret_values: boolean;
  };
  write: { blocked_paths: string[]; trust_required_paths: string[] };
  mounts: { readonly_overlays: string[] };
  killswitch: { file: string; running_value: string; message: string };
}

export interface ContainerSecurityRules {
  bash: {
    blocked: string[];
    blockedEnvVars: string[];
    blockedUrls: string[];
  };
  webfetch: {
    httpsOnly: boolean;
    blockedNetworks: string[];
    blockedUrls: string[];
    blockSecretValues: boolean;
  };
  write: {
    blocked: string[];
    trustRequired: string[];
  };
  tools: {
    blockedUntrusted: string[];
  };
}

// --- Defaults ---

const DEFAULT_BASH_BLOCKED: string[] = [
  '\\bprintenv\\b',
  '\\benv\\b\\s*($|[|>$;&\\n)`-])',
  '\\bexport\\s+-p\\b',
  '\\bdeclare\\s+-[a-z]*[xp]\\b',
  '\\/proc\\/(self|\\d+)\\/environ',
  '\\bset\\b\\s*[|>$]',
  '\\bos\\.environ\\b',
  '\\bprocess\\.env\\b',
  '\\bcompgen\\s+-v\\b',
];

const DEFAULT_WEBFETCH_BLOCKED_NETWORKS: string[] = [
  '^https?://([^@]*@)?(127\\.)',
  '^https?://([^@]*@)?(10\\.)',
  '^https?://([^@]*@)?(172\\.(1[6-9]|2\\d|3[01])\\.)',
  '^https?://([^@]*@)?(192\\.168\\.)',
  '^https?://([^@]*@)?(169\\.254\\.)',
  '^https?://([^@]*@)?(localhost)',
  '^https?://([^@]*@)?(host\\.docker\\.internal)',
  '^https?://([^@]*@)?(0\\.0\\.0\\.0)',
  '^https?://([^@]*@)?(\\[::1\\])',
  '^https?://([^@]*@)?\\[::ffff:',
];

const DEFAULT_WRITE_BLOCKED: string[] = ['CLAUDE\\.md', 'settings\\.json'];

const DEFAULT_WRITE_TRUST_REQUIRED: string[] = [
  '\\/skills\\/',
  'SOUL\\.md',
  'TOOLS\\.md',
  'IDENTITY\\.md',
  'MEMORY\\.md',
];

const DEFAULT_READONLY_OVERLAYS: string[] = ['CLAUDE.md'];

const DEFAULT_POLICY: SecurityPolicy = {
  trust: { owner_ids: [], trusted_members: [] },
  tools: { blocked: [], blocked_untrusted: [] },
  bash: {
    blocked_patterns: DEFAULT_BASH_BLOCKED,
    blocked_env_vars: [],
    blocked_url_patterns: [],
  },
  webfetch: {
    https_only: true,
    blocked_networks: DEFAULT_WEBFETCH_BLOCKED_NETWORKS,
    blocked_url_patterns: [],
    block_secret_values: true,
  },
  write: {
    blocked_paths: DEFAULT_WRITE_BLOCKED,
    trust_required_paths: DEFAULT_WRITE_TRUST_REQUIRED,
  },
  mounts: { readonly_overlays: DEFAULT_READONLY_OVERLAYS },
  killswitch: {
    file: 'killswitch.txt',
    running_value: 'running',
    message: "I'm currently disabled by the kill switch.",
  },
};

// --- Loading ---

export function getDefaultPolicy(): SecurityPolicy {
  return structuredClone(DEFAULT_POLICY);
}

function mergeStringArrays(defaults: string[], user: unknown): string[] {
  if (!Array.isArray(user)) return defaults;
  const valid = user.filter((v): v is string => typeof v === 'string');
  return [...defaults, ...valid];
}

function validateRegexes(patterns: string[], label: string): void {
  for (const p of patterns) {
    try {
      new RegExp(p);
    } catch (err) {
      throw new Error(
        `security-policy: invalid regex in ${label}: "${p}" — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export function loadSecurityPolicy(pathOverride?: string): SecurityPolicy {
  const filePath = pathOverride ?? SECURITY_POLICY_PATH;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return getDefaultPolicy();
    }
    throw new Error(
      `security-policy: cannot read config at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`security-policy: invalid JSON in ${filePath}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`security-policy: root must be an object in ${filePath}`);
  }

  const obj = parsed as Record<string, unknown>;
  const policy = getDefaultPolicy();

  // Trust — owner_ids replaces (not appends) since these are identities
  const trust = obj.trust as Record<string, unknown> | undefined;
  if (trust?.owner_ids && Array.isArray(trust.owner_ids)) {
    policy.trust.owner_ids = trust.owner_ids.filter(
      (v): v is string => typeof v === 'string',
    );
  }
  if (trust?.trusted_members && Array.isArray(trust.trusted_members)) {
    policy.trust.trusted_members = trust.trusted_members.filter(
      (v): v is string => typeof v === 'string',
    );
  }

  // Tools
  const tools = obj.tools as Record<string, unknown> | undefined;
  if (tools) {
    policy.tools.blocked = mergeStringArrays(
      policy.tools.blocked,
      tools.blocked,
    );
    policy.tools.blocked_untrusted = mergeStringArrays(
      policy.tools.blocked_untrusted,
      tools.blocked_untrusted,
    );
  }

  // Bash
  const bash = obj.bash as Record<string, unknown> | undefined;
  if (bash) {
    policy.bash.blocked_patterns = mergeStringArrays(
      policy.bash.blocked_patterns,
      bash.blocked_patterns,
    );
    policy.bash.blocked_env_vars = mergeStringArrays(
      policy.bash.blocked_env_vars,
      bash.blocked_env_vars,
    );
    policy.bash.blocked_url_patterns = mergeStringArrays(
      policy.bash.blocked_url_patterns,
      bash.blocked_url_patterns,
    );
  }

  // WebFetch
  const webfetch = obj.webfetch as Record<string, unknown> | undefined;
  if (webfetch) {
    if (typeof webfetch.https_only === 'boolean') {
      policy.webfetch.https_only = webfetch.https_only;
    }
    policy.webfetch.blocked_networks = mergeStringArrays(
      policy.webfetch.blocked_networks,
      webfetch.blocked_networks,
    );
    policy.webfetch.blocked_url_patterns = mergeStringArrays(
      policy.webfetch.blocked_url_patterns,
      webfetch.blocked_url_patterns,
    );
    if (typeof webfetch.block_secret_values === 'boolean') {
      policy.webfetch.block_secret_values = webfetch.block_secret_values;
    }
  }

  // Write
  const write = obj.write as Record<string, unknown> | undefined;
  if (write) {
    policy.write.blocked_paths = mergeStringArrays(
      policy.write.blocked_paths,
      write.blocked_paths,
    );
    policy.write.trust_required_paths = mergeStringArrays(
      policy.write.trust_required_paths,
      write.trust_required_paths,
    );
  }

  // Mounts
  const mounts = obj.mounts as Record<string, unknown> | undefined;
  if (mounts) {
    policy.mounts.readonly_overlays = mergeStringArrays(
      policy.mounts.readonly_overlays,
      mounts.readonly_overlays,
    );
  }

  // Killswitch
  const killswitch = obj.killswitch as Record<string, unknown> | undefined;
  if (killswitch) {
    if (typeof killswitch.file === 'string') {
      policy.killswitch.file = killswitch.file;
    }
    if (typeof killswitch.running_value === 'string') {
      policy.killswitch.running_value = killswitch.running_value;
    }
    if (typeof killswitch.message === 'string') {
      policy.killswitch.message = killswitch.message;
    }
  }

  // Validate all regex patterns at load time (fail-fast)
  validateRegexes(policy.bash.blocked_patterns, 'bash.blocked_patterns');
  validateRegexes(
    policy.bash.blocked_url_patterns,
    'bash.blocked_url_patterns',
  );
  validateRegexes(
    policy.webfetch.blocked_networks,
    'webfetch.blocked_networks',
  );
  validateRegexes(
    policy.webfetch.blocked_url_patterns,
    'webfetch.blocked_url_patterns',
  );
  validateRegexes(policy.write.blocked_paths, 'write.blocked_paths');
  validateRegexes(
    policy.write.trust_required_paths,
    'write.trust_required_paths',
  );

  return policy;
}

// --- Helpers ---

export function isSenderTrusted(
  policy: SecurityPolicy,
  senderId: string,
): boolean {
  if (policy.trust.owner_ids.length === 0) return false;
  return policy.trust.owner_ids.includes(senderId);
}

export function readKillswitch(
  policy: SecurityPolicy,
  groupFolder: string,
): { canRun: boolean; message: string } {
  const groupDir = resolveGroupFolderPath(groupFolder);
  const ksPath = path.join(groupDir, 'data', policy.killswitch.file);

  try {
    const content = fs
      .readFileSync(ksPath, 'utf-8')
      .replace(/^\uFEFF/, '')
      .trim();
    if (content === policy.killswitch.running_value) {
      return { canRun: true, message: '' };
    }
    return { canRun: false, message: policy.killswitch.message };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { canRun: true, message: '' };
    }
    logger.error(
      { err, ksPath },
      'killswitch: unexpected read error, failing closed',
    );
    return { canRun: false, message: policy.killswitch.message };
  }
}

export function buildAllowedTools(policy: SecurityPolicy): string[] {
  const all = [
    'Bash',
    'Read',
    'Write',
    'Edit',
    'Glob',
    'Grep',
    'WebSearch',
    'WebFetch',
    'Task',
    'TaskOutput',
    'TaskStop',
    'TeamCreate',
    'TeamDelete',
    'SendMessage',
    'TodoWrite',
    'ToolSearch',
    'Skill',
    'NotebookEdit',
    'mcp__nanoclaw__*',
  ];
  const blocked = new Set(policy.tools.blocked);
  return all.filter((t) => !blocked.has(t));
}

export function buildContainerSecurityRules(
  policy: SecurityPolicy,
): ContainerSecurityRules {
  return {
    bash: {
      blocked: policy.bash.blocked_patterns,
      blockedEnvVars: policy.bash.blocked_env_vars,
      blockedUrls: policy.bash.blocked_url_patterns,
    },
    webfetch: {
      httpsOnly: policy.webfetch.https_only,
      blockedNetworks: policy.webfetch.blocked_networks,
      blockedUrls: policy.webfetch.blocked_url_patterns,
      blockSecretValues: policy.webfetch.block_secret_values,
    },
    write: {
      blocked: policy.write.blocked_paths,
      trustRequired: policy.write.trust_required_paths,
    },
    tools: {
      blockedUntrusted: policy.tools.blocked_untrusted,
    },
  };
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

export function buildReadonlyOverlays(
  policy: SecurityPolicy,
  groupDir: string,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];

  for (const overlay of policy.mounts.readonly_overlays) {
    const hostPath = path.join(groupDir, overlay);
    if (fs.existsSync(hostPath)) {
      mounts.push({
        hostPath,
        containerPath: `/workspace/group/${overlay}`,
        readonly: true,
      });
    }
  }

  // Killswitch file (lives in data/ which may be a symlink)
  try {
    const dataRealPath = fs.realpathSync(path.join(groupDir, 'data'));
    const ksPath = path.join(dataRealPath, policy.killswitch.file);
    if (fs.existsSync(ksPath)) {
      mounts.push({
        hostPath: ksPath,
        containerPath: `/workspace/group/data/${policy.killswitch.file}`,
        readonly: true,
      });
    }
  } catch {
    /* data dir missing — skip */
  }

  return mounts;
}
