/**
 * Agent-level customization sync: instructions, skills, and MCP servers.
 *
 * Writes instructions to {agentDir}/CLAUDE.md, copies skill
 * directories to {agentDir}/skills/, and copies MCP server sources
 * to {agentDir}/mcp/. Validates structure and detects collisions.
 */
import fs from 'fs';
import path from 'path';

import type { McpServerConfig } from './api/options.js';
import { copyDirRecursive } from './utils.js';

export interface SyncAgentCustomizationsInput {
  /** Agent-level instructions string. */
  instructions: string | null;
  /** Absolute paths to user skill directories. */
  skillsSources: string[] | null;
  /** Custom MCP server configurations (with absolute source paths). */
  mcpServers: Record<string, McpServerConfig> | null;
  /** Destination directory for agent customizations. */
  agentDir: string;
  /** Path to the package's container/skills/ directory (for collision checks). */
  builtinSkillsDir: string;
}

/**
 * Sync agent-level instructions, skills, and MCP servers into the managed agent directory.
 * Called on every agent.start() to pick up source changes.
 */
export function syncAgentCustomizations(
  input: SyncAgentCustomizationsInput,
): void {
  const {
    instructions,
    skillsSources,
    mcpServers,
    agentDir,
    builtinSkillsDir,
  } = input;

  if (instructions) {
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'CLAUDE.md'), instructions);
  }

  if (skillsSources) {
    const builtinNames = fs.existsSync(builtinSkillsDir)
      ? fs
          .readdirSync(builtinSkillsDir)
          .filter((e) =>
            fs.statSync(path.join(builtinSkillsDir, e)).isDirectory(),
          )
      : [];

    const agentSkillsDir = path.join(agentDir, 'skills');
    // Clear stale skills before re-sync
    if (fs.existsSync(agentSkillsDir)) {
      fs.rmSync(agentSkillsDir, { recursive: true });
    }
    fs.mkdirSync(agentSkillsDir, { recursive: true });

    for (const srcPath of skillsSources) {
      if (!fs.existsSync(srcPath) || !fs.statSync(srcPath).isDirectory()) {
        throw new Error(`Skill source is not a directory: ${srcPath}`);
      }
      if (!fs.existsSync(path.join(srcPath, 'SKILL.md'))) {
        throw new Error(`Skill directory missing SKILL.md: ${srcPath}`);
      }
      const skillName = path.basename(srcPath);
      if (builtinNames.includes(skillName)) {
        throw new Error(`Skill "${skillName}" collides with built-in skill`);
      }
      copyDirRecursive(srcPath, path.join(agentSkillsDir, skillName));
    }
  }

  // Sync MCP server sources
  const agentMcpDir = path.join(agentDir, 'mcp');
  if (mcpServers) {
    // Clear stale MCP sources before re-sync
    if (fs.existsSync(agentMcpDir)) {
      fs.rmSync(agentMcpDir, { recursive: true });
    }
    fs.mkdirSync(agentMcpDir, { recursive: true });

    for (const [name, cfg] of Object.entries(mcpServers)) {
      if (
        !fs.existsSync(cfg.source) ||
        !fs.statSync(cfg.source).isDirectory()
      ) {
        throw new Error(
          `MCP server "${name}" source is not a directory: ${cfg.source}`,
        );
      }
      copyDirRecursive(cfg.source, path.join(agentMcpDir, name));
    }
  } else if (fs.existsSync(agentMcpDir)) {
    // No MCP servers configured — clean up any previous copies
    fs.rmSync(agentMcpDir, { recursive: true });
  }
}
