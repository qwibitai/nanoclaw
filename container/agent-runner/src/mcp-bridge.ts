import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport as StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function log(message: string): void {
  console.error(`[mcp-bridge] ${message}`);
}

interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface McpBridgeInput {
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
}

export function buildMcpServerConfigs(
  input: McpBridgeInput,
): Record<string, McpServerConfig> {
  const mcpServerPath = path.join(__dirname, 'nanoclaw-mcp.js');
  const servers: Record<string, McpServerConfig> = {};

  // Nanoclaw IPC MCP server (always registered)
  if (fs.existsSync(mcpServerPath)) {
    servers['nanoclaw'] = {
      command: 'node',
      args: [mcpServerPath],
      env: {
        NANOCLAW_CHAT_JID: input.chatJid,
        NANOCLAW_GROUP_FOLDER: input.groupFolder,
        NANOCLAW_IS_MAIN: input.isMain ? '1' : '0',
      },
    };
  }

  // Gmail MCP servers — one per account with mounted credentials
  const gmailAccounts = [
    { name: 'gmail-personal', dir: '.gmail-mcp' },
    { name: 'gmail-whoisxml', dir: '.gmail-mcp-jonathan' },
    { name: 'gmail-attaxion', dir: '.gmail-mcp-attaxion' },
    { name: 'gmail-dev', dir: '.gmail-mcp-dev' },
  ];
  for (const acct of gmailAccounts) {
    const credsPath = `/home/node/${acct.dir}/credentials.json`;
    const oauthPath = `/home/node/${acct.dir}/gcp-oauth.keys.json`;
    if (fs.existsSync(credsPath)) {
      servers[acct.name] = {
        command: 'npx',
        args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'],
        env: {
          GMAIL_OAUTH_PATH: oauthPath,
          GMAIL_CREDENTIALS_PATH: credsPath,
        },
      };
      log(`Gmail account ${acct.name} registered`);
    }
  }
  // Backwards compat: also register as plain "gmail" pointing to personal
  if (servers['gmail-personal']) {
    servers['gmail'] = servers['gmail-personal'];
  }

  // Notion MCP server
  const notionToken = process.env.NOTION_TOKEN || process.env.NOTION_API_KEY;
  if (notionToken) {
    servers['notion'] = {
      command: 'npx',
      args: ['-y', '@notionhq/notion-mcp-server'],
      env: {
        OPENAPI_MCP_HEADERS: JSON.stringify({
          Authorization: `Bearer ${notionToken}`,
          'Notion-Version': '2022-06-28',
        }),
      },
    };
    log('Notion MCP server registered');
  }

  // SuperPilot MCP server
  const superpilotApiUrl = process.env.SUPERPILOT_API_URL;
  const serviceToken = process.env.NANOCLAW_SERVICE_TOKEN;
  if (superpilotApiUrl && serviceToken) {
    const superpilotMcpPath = path.join(__dirname, 'superpilot-mcp.js');
    if (fs.existsSync(superpilotMcpPath)) {
      servers['superpilot'] = {
        command: 'node',
        args: [superpilotMcpPath],
        env: {
          SUPERPILOT_API_URL: superpilotApiUrl,
          NANOCLAW_SERVICE_TOKEN: serviceToken,
        },
      };
      log('SuperPilot MCP server registered');
    }
  }

  return servers;
}

export async function connectMcpServers(
  configs: Record<string, McpServerConfig>,
): Promise<{
  tools: Record<string, unknown>;
  cleanup: () => Promise<void>;
}> {
  const clients: MCPClient[] = [];
  const allTools: Record<string, unknown> = {};

  for (const [name, config] of Object.entries(configs)) {
    try {
      const transport = new StdioMCPTransport({
        command: config.command,
        args: config.args,
        env: { ...(process.env as Record<string, string>), ...config.env },
      });

      const client = await createMCPClient({
        transport,
        name: `nanoclaw-${name}`,
      });

      clients.push(client);
      const tools = await client.tools();

      for (const [toolName, toolDef] of Object.entries(tools)) {
        const prefixedName = `mcp__${name}__${toolName}`;
        allTools[prefixedName] = toolDef;
      }

      log(`Connected to MCP server "${name}" — ${Object.keys(tools).length} tools`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Failed to connect to MCP server "${name}": ${errMsg}`);
    }
  }

  return {
    tools: allTools,
    cleanup: async () => {
      for (const client of clients) {
        try {
          await client.close();
        } catch {
          // Ignore cleanup errors
        }
      }
    },
  };
}
