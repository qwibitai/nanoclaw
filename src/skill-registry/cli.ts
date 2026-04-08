/**
 * Skill Registry CLI
 *
 * Provides `nanoclaw skill search|install|list|info|update` commands.
 * Designed to be invoked from the main CLI entry point.
 */

import {
  searchSkills,
  getAllSkills,
  findSkill,
  clearCache,
} from './registry-client.js';
import { installSkill, uninstallSkill } from './installer.js';
import {
  loadInstalledSkills,
  detectInstalledFromGit,
  getInstalledSkill,
} from './local-state.js';
import type { SkillMetadata } from './types.js';

/** Format a skill for display. */
function formatSkill(
  skill: SkillMetadata & { source: string },
  installed: boolean,
): string {
  const status = installed ? ' [installed]' : '';
  const tags = skill.tags.length > 0 ? ` (${skill.tags.join(', ')})` : '';
  return `  ${skill.name}${status} - ${skill.description}${tags}`;
}

/** Format detailed skill info. */
function formatSkillDetail(
  skill: SkillMetadata & { source: string },
  installed: boolean,
): string {
  const lines = [
    `Name:         ${skill.displayName} (${skill.name})`,
    `Version:      ${skill.version}`,
    `Type:         ${skill.type}`,
    `Install:      ${skill.installMethod}`,
    `Author:       ${skill.author}`,
    `Source:       ${skill.source}`,
    `Status:       ${installed ? 'Installed' : 'Not installed'}`,
    `Description:  ${skill.description}`,
  ];

  if (skill.tags.length > 0) {
    lines.push(`Tags:         ${skill.tags.join(', ')}`);
  }
  if (skill.dependencies.length > 0) {
    lines.push(`Requires:     ${skill.dependencies.join(', ')}`);
  }
  if (skill.triggers.length > 0) {
    lines.push(`Triggers:     ${skill.triggers.join(', ')}`);
  }
  if (skill.branch) {
    lines.push(`Branch:       ${skill.branch}`);
  }
  if (skill.license) {
    lines.push(`License:      ${skill.license}`);
  }
  if (skill.updatedAt) {
    lines.push(`Updated:      ${skill.updatedAt}`);
  }
  if (skill.longDescription) {
    lines.push('', skill.longDescription);
  }

  return lines.join('\n');
}

/** `nanoclaw skill search <query>` */
export async function cmdSearch(query: string): Promise<string> {
  if (!query) {
    return 'Usage: nanoclaw skill search <query>\n\nSearch for skills by name, description, or tags.';
  }

  const results = await searchSkills(query);
  const installed = loadInstalledSkills();

  if (results.length === 0) {
    return `No skills found matching "${query}".`;
  }

  const lines = [`Found ${results.length} skill(s) matching "${query}":\n`];
  for (const skill of results) {
    lines.push(formatSkill(skill, skill.name in installed.skills));
  }
  lines.push(
    '',
    'Run "nanoclaw skill info <name>" for details.',
    'Run "nanoclaw skill install <name>" to install.',
  );

  return lines.join('\n');
}

/** `nanoclaw skill list` */
export async function cmdList(
  options: { all?: boolean; type?: string } = {},
): Promise<string> {
  const installed = loadInstalledSkills();
  const installedNames = new Set(Object.keys(installed.skills));

  if (options.all) {
    // Show all available skills
    let skills = await getAllSkills();
    if (options.type) {
      skills = skills.filter((s) => s.type === options.type);
    }

    if (skills.length === 0) {
      return 'No skills available in configured marketplaces.';
    }

    const lines = ['Available skills:\n'];

    // Group by type
    const byType = new Map<string, typeof skills>();
    for (const skill of skills) {
      const group = byType.get(skill.type) || [];
      group.push(skill);
      byType.set(skill.type, group);
    }

    for (const [type, typeSkills] of byType) {
      lines.push(`${type.charAt(0).toUpperCase() + type.slice(1)} skills:`);
      for (const skill of typeSkills) {
        lines.push(formatSkill(skill, installedNames.has(skill.name)));
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  // Show only installed skills
  if (installedNames.size === 0) {
    // Try detecting from git history
    const gitDetected = await detectInstalledFromGit();
    if (gitDetected.length > 0) {
      const lines = [
        'No skills tracked in registry, but detected from git history:\n',
      ];
      for (const name of gitDetected) {
        lines.push(`  ${name} (detected from merge history)`);
      }
      lines.push(
        '',
        'Run "nanoclaw skill list --all" to see all available skills.',
      );
      return lines.join('\n');
    }

    return 'No skills installed.\n\nRun "nanoclaw skill list --all" to browse available skills.\nRun "nanoclaw skill search <query>" to search.';
  }

  const lines = ['Installed skills:\n'];
  for (const [name, record] of Object.entries(installed.skills)) {
    const date = new Date(record.installedAt).toLocaleDateString();
    const update = record.updateAvailable ? ' [update available]' : '';
    lines.push(`  ${name} v${record.version} (installed ${date})${update}`);
  }
  lines.push(
    '',
    `${installedNames.size} skill(s) installed.`,
    'Run "nanoclaw skill list --all" to see all available skills.',
  );

  return lines.join('\n');
}

/** `nanoclaw skill info <name>` */
export async function cmdInfo(name: string): Promise<string> {
  if (!name) {
    return 'Usage: nanoclaw skill info <name>\n\nShow detailed information about a skill.';
  }

  const skill = await findSkill(name);
  if (!skill) {
    return `Skill "${name}" not found. Run "nanoclaw skill search ${name}" to search.`;
  }

  const installed = getInstalledSkill(name);
  return formatSkillDetail(skill, installed !== null);
}

/** `nanoclaw skill install <name>` */
export async function cmdInstall(name: string): Promise<string> {
  if (!name) {
    return 'Usage: nanoclaw skill install <name>\n\nInstall a skill from the marketplace.';
  }

  const result = await installSkill(name);
  return result.message;
}

/** `nanoclaw skill uninstall <name>` */
export async function cmdUninstall(name: string): Promise<string> {
  if (!name) {
    return 'Usage: nanoclaw skill uninstall <name>\n\nUninstall a previously installed skill.';
  }

  const result = await uninstallSkill(name);
  return result.message;
}

/** `nanoclaw skill cache-clear` */
export function cmdCacheClear(): string {
  clearCache();
  return 'Skill registry cache cleared.';
}

/** Main CLI router for `nanoclaw skill <subcommand>`. */
export async function handleSkillCommand(args: string[]): Promise<string> {
  const subcommand = args[0];
  const rest = args.slice(1);

  switch (subcommand) {
    case 'search':
      return cmdSearch(rest.join(' '));

    case 'list':
    case 'ls': {
      const all = rest.includes('--all') || rest.includes('-a');
      const typeFlag = rest.find((a) => a.startsWith('--type='));
      const type = typeFlag?.split('=')[1];
      return cmdList({ all, type });
    }

    case 'info':
    case 'show':
      return cmdInfo(rest[0]);

    case 'install':
    case 'add':
      return cmdInstall(rest[0]);

    case 'uninstall':
    case 'remove':
    case 'rm':
      return cmdUninstall(rest[0]);

    case 'cache-clear':
      return cmdCacheClear();

    default:
      return [
        'NanoClaw Skill Registry',
        '',
        'Usage: nanoclaw skill <command> [options]',
        '',
        'Commands:',
        '  search <query>       Search for skills by name, description, or tags',
        '  list [--all]         List installed skills (--all for all available)',
        '  info <name>          Show detailed skill information',
        '  install <name>       Install a skill from the marketplace',
        '  uninstall <name>     Uninstall a skill',
        '  cache-clear          Clear the registry cache',
        '',
        'Examples:',
        '  nanoclaw skill search telegram',
        '  nanoclaw skill list --all',
        '  nanoclaw skill install add-telegram',
        '  nanoclaw skill info add-discord',
      ].join('\n');
    }
}
