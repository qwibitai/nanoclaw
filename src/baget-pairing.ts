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
 *        - Copies setup/baget-template/container_config.json into the
 *          runtime `groups/<folder>/container.json`, with
 *          BAGET_COMPANY_ID + secret name patched in
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
 * Per-founder team names sent to this fork at provision time. CoS is
 * the only required member — every founder has a CoS regardless of
 * their plan (apprenti has CoS + Intern; intern is not modeled here).
 * The remaining specialists are optional and only sent when the
 * founder has actively-hired that role on baget.ai's dashboard.
 *
 * When a specialist is omitted:
 *   - The renderer strips the role's block from CLAUDE.local.md (so
 *     the LLM doesn't think a "Clara the analyst" exists when only
 *     CoS is hired).
 *   - The persona resolver falls back to the CoS persona if the
 *     model still tags a reply with that role.
 *
 * Adding a new role: extend this type, add `<!--role:X-->...<!--/role:X-->`
 * blocks in the template, and add the role to OPTIONAL_ROLES below.
 */
export type BagetTeamMembers = {
  cos: string;
  developer?: string;
  marketing?: string;
  analyst?: string;
  design?: string;
  ops?: string;
};

/**
 * The optional specialist roles, in template order. CoS is always
 * present (handled separately in the renderer + validator). Exported
 * so `baget-admin-server.ts` and `channels/baget-telegram.ts` can
 * import the canonical list — keeping all role-set knowledge in one
 * file prevents drift when a new role lands.
 */
export const OPTIONAL_ROLES = ['developer', 'marketing', 'analyst', 'design', 'ops'] as const;
export type OptionalRole = (typeof OPTIONAL_ROLES)[number];

/**
 * Every role the fork knows about, in stable order. CoS first, then
 * specialists. Used by the validator to reject unknown role keys.
 * Intern is intentionally not here — the fork doesn't model an
 * intern persona; baget.ai is responsible for filtering it before
 * the wire payload arrives.
 */
export const ALL_ROLES = ['cos', ...OPTIONAL_ROLES] as const;
export type AllRole = (typeof ALL_ROLES)[number];

/**
 * Required placeholders that MUST have a non-empty value at render time.
 * Specialist placeholders (e.g. `developer_name`) are only required when
 * the corresponding role is present in `teamMembers` — see render logic.
 */
const REQUIRED_PLACEHOLDERS: ReadonlyArray<string> = ['company_name', 'cos_name'];

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
 * Two-phase render:
 *
 *   1. Pre-process role blocks. Lines wrapped in
 *      `<!--role:X-->...<!--/role:X-->` are kept iff `teamMembers[X]`
 *      is a non-empty string. When a specialist role is missing, its
 *      block is stripped before substitution so the resulting prompt
 *      doesn't reference roster members the founder hasn't hired.
 *
 *   2. Substitute placeholders. `{{key}}` → variables[key].
 *      - Unknown placeholders throw — better to fail loudly at
 *        provision time than to ship a half-rendered prompt.
 *      - Missing required placeholders (company_name, cos_name) throw.
 *      - Specialist placeholders that have already been stripped via
 *        block removal don't need a value.
 */
export function renderBagetClaudeMd(args: RenderClaudeMdArgs): string {
  const templatePath = args.templatePath ?? BAGET_TEMPLATE_FILE;
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Baget template not found at ${templatePath}`);
  }
  const rawTemplate = fs.readFileSync(templatePath, 'utf8');

  // Determine which optional roles are present + valid. A role with
  // an empty / whitespace-only string counts as missing — the
  // dashboard-side caller is expected to omit absent roles entirely,
  // but we treat an empty value as "absent" so a sloppy caller can't
  // accidentally render `- 💻 ** ** — Developer.` lines.
  const presentRoles = new Set<OptionalRole>();
  for (const role of OPTIONAL_ROLES) {
    const v = args.teamMembers[role];
    if (typeof v === 'string' && v.trim().length > 0) {
      presentRoles.add(role);
    }
  }

  // Strip role blocks for missing roles, then strip the markers for
  // roles that are present. Done before placeholder substitution so a
  // missing `developer_name` placeholder inside a stripped block isn't
  // flagged as an unsubstituted-placeholder error below.
  const template = stripRoleBlocks(rawTemplate, presentRoles);

  // Sanity check: after processing, no `<!--role:` or `<!--/role:`
  // markers should remain. A leftover marker means the template has
  // an unbalanced / mismatched / typo'd block (e.g. open without
  // close, or a close tag for a role that doesn't exist in
  // OPTIONAL_ROLES). Fail loud at provision time so the operator sees
  // it instead of letting half-rendered template directives leak into
  // the LLM's context.
  const leftover = /<!--\/?role:[a-z]+-->/.exec(template);
  if (leftover) {
    throw new Error(
      `Baget template render: orphan role marker "${leftover[0]}" left after block processing — check template for typos or unbalanced markers`,
    );
  }

  const vars: Record<string, string> = {
    company_name: args.companyName,
    cos_name: args.teamMembers.cos,
  };
  for (const role of OPTIONAL_ROLES) {
    if (presentRoles.has(role)) {
      vars[`${role}_name`] = args.teamMembers[role] as string;
    }
  }

  // Verify every required placeholder has a non-empty value before
  // substitution. Empty names produce confusing prompts ("- 🧭  —
  // Chief of Staff") that are hard to debug.
  for (const key of REQUIRED_PLACEHOLDERS) {
    const v = vars[key];
    if (typeof v !== 'string' || v.trim().length === 0) {
      throw new Error(`Baget template render: required placeholder "${key}" is empty or missing`);
    }
  }

  // Validate every {{placeholder}} in the (block-stripped) template is
  // something we can substitute. Catches new placeholders the renderer
  // doesn't know about — and missing specialist names whose block
  // wasn't gated by a role marker (template author error).
  const seenPlaceholders = new Set<string>();
  template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    seenPlaceholders.add(key);
    return '';
  });
  for (const key of seenPlaceholders) {
    if (!(key in vars)) {
      throw new Error(`Baget template render: template uses {{${key}}} but renderer has no value for it`);
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
 * Process `<!--role:X-->...<!--/role:X-->` blocks in the template:
 *   - For each role NOT in `presentRoles`, drop the entire block
 *     (markers + content), including the trailing newline so we don't
 *     leave blank gaps in the prompt.
 *   - For each role IN `presentRoles`, drop just the marker comments
 *     (keep the content) — the LLM should never see template-internal
 *     directives.
 *
 * The regex anchors on `<!--role:X-->` and `<!--/role:X-->` and matches
 * across newlines. Blocks must NOT nest — each role's open marker must
 * be closed before another opens. The template is hand-authored so this
 * is enforced by review, not by a parser.
 */
function stripRoleBlocks(template: string, presentRoles: Set<OptionalRole>): string {
  let out = template;
  for (const role of OPTIONAL_ROLES) {
    // Match `<!--role:X-->\n? ... \n?<!--/role:X-->` plus an optional
    // trailing newline so removed blocks don't leave a blank line.
    const blockRe = new RegExp(`<!--role:${role}-->\\n?[\\s\\S]*?<!--/role:${role}-->\\n?`, 'g');
    if (presentRoles.has(role)) {
      // Keep the content, drop only the markers (and any single trailing
      // newline immediately after each marker so we don't leave double
      // blank lines).
      out = out.replace(new RegExp(`<!--role:${role}-->\\n?`, 'g'), '');
      out = out.replace(new RegExp(`<!--/role:${role}-->\\n?`, 'g'), '');
    } else {
      // Drop the whole block.
      out = out.replace(blockRe, '');
    }
  }
  return out;
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
 * picks up on every spawn), and write a per-group runtime container config
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
  /** Source for the BAGET_API_BASE_URL env in container.json. Must
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

export function provisionBagetGroup(args: ProvisionBagetGroupArgs): ProvisionedBagetGroup {
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
  //    with founder-specific values, and write the result to the
  //    runtime `container.json` file that the runner actually mounts.
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
    secrets: [...(baseConfig.secrets ?? []), args.channelTokenCredentialName].filter(
      (v, i, arr) => arr.indexOf(v) === i,
    ),
  };

  // Strip the _*_note keys we use for human reference in the template.
  if (config.env) {
    for (const key of Object.keys(config.env)) {
      if (key.startsWith('_')) delete (config.env as Record<string, unknown>)[key];
    }
  }

  const configPath = path.join(groupDir, 'container.json');
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
