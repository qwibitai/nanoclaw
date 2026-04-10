/**
 * MCP config generator — writes a temporary JSON config file for --mcp-config.
 */

import fs from 'fs';
import path from 'path';

interface McpConfigOptions {
  mcpServerPath: string;
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
}

/**
 * Write a temporary MCP config JSON file and return its path.
 * The file is written to /tmp/ to avoid polluting the workspace.
 */
export function writeMcpConfig(options: McpConfigOptions): string {
  const config = {
    mcpServers: {
      nanoclaw: {
        command: 'node',
        args: [options.mcpServerPath],
        env: {
          NANOCLAW_CHAT_JID: options.chatJid,
          NANOCLAW_GROUP_FOLDER: options.groupFolder,
          NANOCLAW_IS_MAIN: options.isMain ? '1' : '0',
        },
      },
    },
  };

  const configPath = path.join('/tmp', `nanoclaw-mcp-${process.pid}.json`);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}
