/**
 * Baget pairing — admin API + template renderer for self-service
 * agent_group provisioning.
 *
 * Flow:
 *
 *   1. Founder taps "Open a channel with your team" on the baget.ai
 *      dashboard.
 *   2. baget.ai backend reads the founder's team names (the same names
 *      shown on the dashboard) from `companies.teamMembers`.
 *   3. baget.ai backend POSTs to this nanoclaw fork's admin API:
 *        POST /baget/agent-groups
 *        { userId, companyId, teamMembers: { cos: 'Louis', ... },
 *          companyName: 'Acme', companyId, channelToken: '...' }
 *   4. This module:
 *        - Renders setup/baget-template/CLAUDE.md.template with the
 *          provided team names → writes to
 *          groups/baget-<userId>-<companyId>/CLAUDE.local.md
 *        - Copies setup/baget-template/container_config.json to
 *          the same folder, with BAGET_COMPANY_ID + secret name
 *          patched in
 *        - Inserts an `agent_groups` row in the central DB
 *        - Mints a single-use Telegram pairing token (5min TTL)
 *        - Returns { groupId, telegramDeepLink }
 *   5. baget.ai redirects the founder to the deep link.
 *   6. Founder taps /start <token> on Telegram → channel adapter binds
 *      the chat to the agent_group.
 *
 * Why per-founder team names matter: if Founder A's dashboard shows
 * their CoS as "Louis" and Founder B's shows "Marc", they should hear
 * THEIR names in chat too. The template uses {{cos_name}} placeholders;
 * this module fills them at agent_group creation time, then `composeGroupClaudeMd`
 * (existing) picks up the per-group CLAUDE.local.md on every container
 * spawn — so the personalization survives container restarts.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';

// Source path for the Baget template — at this fork's root, NOT under
// groups/ (which is gitignored per-install state).
const BAGET_TEMPLATE_DIR = path.join(process.cwd(), 'setup', 'baget-template');
const BAGET_TEMPLATE_FILE = path.join(BAGET_TEMPLATE_DIR, 'CLAUDE.md.template');

/**
 * The closed set of role placeholders the Baget template uses. Adding a
 * new role: extend this type, the template, AND the renderer's required-
 * key check below — the renderer fails fast on missing keys to surface
 * a typo before the agent_group is created with a half-rendered prompt.
 */
export type BagetTeamMembers = {
  cos: string;
  strategist: string;
  developer: string;
  marketing: string;
  analyst: string;
  design: string;
};

const REQUIRED_PLACEHOLDERS: ReadonlyArray<string> = [
  'company_name',
  'cos_name',
  'strategist_name',
  'developer_name',
  'marketing_name',
  'analyst_name',
  'design_name',
];

export interface RenderClaudeMdArgs {
  companyName: string;
  teamMembers: BagetTeamMembers;
  /** Optional override for the template path — used by tests. */
  templatePath?: string;
}

/**
 * Render the Baget CLAUDE.md template with founder-specific team names.
 * Returns the fully-substituted markdown content.
 *
 * Substitution rules:
 *   - `{{key}}` → variables[key]
 *   - Unknown placeholders throw — better to fail loudly at provision
 *     time than to ship a half-rendered prompt to the founder.
 *   - Missing required placeholders throw — same reason.
 */
export function renderBagetClaudeMd(args: RenderClaudeMdArgs): string {
  const templatePath = args.templatePath ?? BAGET_TEMPLATE_FILE;
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Baget template not found at ${templatePath}`);
  }
  const template = fs.readFileSync(templatePath, 'utf8');

  const vars: Record<string, string> = {
    company_name: args.companyName,
    cos_name: args.teamMembers.cos,
    strategist_name: args.teamMembers.strategist,
    developer_name: args.teamMembers.developer,
    marketing_name: args.teamMembers.marketing,
    analyst_name: args.teamMembers.analyst,
    design_name: args.teamMembers.design,
  };

  // Verify every required placeholder has a non-empty value before
  // substitution. Empty names produce confusing prompts ("- 🧭  —
  // Chief of Staff") that are hard to debug.
  for (const key of REQUIRED_PLACEHOLDERS) {
    const v = vars[key];
    if (typeof v !== 'string' || v.trim().length === 0) {
      throw new Error(
        `Baget template render: required placeholder "${key}" is empty or missing`,
      );
    }
  }

  // Validate every {{placeholder}} in the template is something we can
  // substitute. Catches new placeholders added to the template that the
  // renderer doesn't know about.
  const seenPlaceholders = new Set<string>();
  template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    seenPlaceholders.add(key);
    return '';
  });
  for (const key of seenPlaceholders) {
    if (!(key in vars)) {
      throw new Error(
        `Baget template render: template uses {{${key}}} but renderer has no value for it`,
      );
    }
  }

  // Substitute. Mustache-style, no escaping (the template content is
  // controlled by us; founder team names are NOT trusted, but they go
  // into a markdown context where the worst case is broken formatting,
  // not exec — we still strip control chars below as defense-in-depth).
  const rendered = template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
    const v = vars[key];
    return sanitizeForPrompt(v);
  });

  return rendered;
}

/**
 * Strip characters that could disrupt the prompt structure or render
 * weirdly in the model's context: newlines (would split list items),
 * markdown emphasis (`*_`backtick), and leading/trailing whitespace.
 *
 * Founder-controlled inputs (team names, company name) flow through
 * here. The cap is generous (60 chars) — anything longer than that is
 * almost certainly a copy-paste mistake by the founder.
 */
function sanitizeForPrompt(value: string): string {
  return value
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[*_`]/g, '')
    .trim()
    .slice(0, 60);
}

/**
 * Provision a Baget agent_group: render the prompt, write it to the
 * group folder as `CLAUDE.local.md` (which `composeGroupClaudeMd`
 * picks up on every spawn), and write a per-group container_config
 * derived from the template.
 *
 * Returns the resolved group folder name, NOT the agent_groups row id.
 * The caller (the admin API handler) inserts the DB row using its
 * own session-manager — keeping this module pure file-IO so it's
 * trivially testable without a DB.
 */
export interface ProvisionBagetGroupArgs {
  userId: string;
  companyId: string;
  companyName: string;
  teamMembers: BagetTeamMembers;
  /** Source for the BAGET_API_BASE_URL env in container_config. Must
   *  match the founder's environment (staging vs prod). */
  bagetApiBaseUrl: string;
  /** OneCLI credential name for this founder's channel token. The
   *  caller is responsible for actually creating the OneCLI cred
   *  before invoking this — we just record the name. */
  channelTokenCredentialName: string;
}

export interface ProvisionedBagetGroup {
  /** Slug used as the groups/ subfolder name. Format:
   *  `baget-<userId-prefix-8>-<companyId-prefix-8>`. Stable for
   *  re-provision (idempotent — running provision twice for the same
   *  (user, company) tuple lands the same folder, just refreshes the
   *  rendered prompt). */
  folder: string;
  /** Absolute path to the group dir. */
  groupDir: string;
  /** Path to the rendered CLAUDE.local.md. */
  claudeLocalPath: string;
}

export function provisionBagetGroup(
  args: ProvisionBagetGroupArgs,
): ProvisionedBagetGroup {
  const folder = bagetGroupFolderName(args.userId, args.companyId);
  const groupDir = path.resolve(GROUPS_DIR, folder);
  fs.mkdirSync(groupDir, { recursive: true });

  // 1. Render the persona prompt + write to CLAUDE.local.md (atomic).
  const rendered = renderBagetClaudeMd({
    companyName: args.companyName,
    teamMembers: args.teamMembers,
  });
  const claudeLocalPath = path.join(groupDir, 'CLAUDE.local.md');
  const tmpClaude = `${claudeLocalPath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpClaude, rendered, { encoding: 'utf8', mode: 0o644 });
  fs.renameSync(tmpClaude, claudeLocalPath);

  // 2. Container config — start from the template, override env fields
  //    with founder-specific values.
  const tmplConfigPath = path.join(BAGET_TEMPLATE_DIR, 'container_config.json');
  if (!fs.existsSync(tmplConfigPath)) {
    throw new Error(`container_config template not found at ${tmplConfigPath}`);
  }
  const baseConfig = JSON.parse(fs.readFileSync(tmplConfigPath, 'utf8')) as {
    env?: Record<string, string | undefined>;
    secrets?: string[];
    [k: string]: unknown;
  };
  const config = {
    ...baseConfig,
    env: {
      ...(baseConfig.env ?? {}),
      BAGET_API_BASE_URL: args.bagetApiBaseUrl,
      BAGET_COMPANY_ID: args.companyId,
    },
    secrets: [
      ...(baseConfig.secrets ?? []),
      args.channelTokenCredentialName,
    ].filter((v, i, arr) => arr.indexOf(v) === i),
  };

  // Strip the _*_note keys we use for human reference in the template.
  if (config.env) {
    for (const key of Object.keys(config.env)) {
      if (key.startsWith('_')) delete (config.env as Record<string, unknown>)[key];
    }
  }

  const configPath = path.join(groupDir, 'container_config.json');
  const tmpConfig = `${configPath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpConfig, JSON.stringify(config, null, 2), {
    encoding: 'utf8',
    mode: 0o644,
  });
  fs.renameSync(tmpConfig, configPath);

  return { folder, groupDir, claudeLocalPath };
}

/**
 * Stable, deterministic group-folder name from (userId, companyId).
 * Truncates UUIDs to 8 chars each so the folder name stays human-
 * readable at the cost of an astronomically small collision risk
 * (2^64 inputs, 16-char output).
 */
export function bagetGroupFolderName(userId: string, companyId: string): string {
  const u = userId.replace(/-/g, '').slice(0, 8);
  const c = companyId.replace(/-/g, '').slice(0, 8);
  return `baget-${u}-${c}`;
}
