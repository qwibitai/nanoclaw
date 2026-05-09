/**
 * Self-modification MCP tools: install_packages, add_mcp_server.
 *
 * Both are fire-and-forget — the tool writes a system action row and returns
 * immediately. The host processes the request (including admin approval)
 * and notifies the agent via a chat message when complete. Admin approval
 * is approval to apply the change: `install_packages` auto-rebuilds the
 * per-agent image and restarts the container; `add_mcp_server` just
 * updates `container.json` and restarts (bun runs TS directly — no build
 * step needed for a pure MCP wiring change).
 *
 * Package names are sanitized here at the tool boundary AND re-validated on
 * the host side (defense in depth).
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

const APT_RE = /^[a-z0-9][a-z0-9._+-]*$/;
const NPM_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const MAX_PACKAGES = 20;

export const installPackages: McpToolDefinition = {
  tool: {
    name: 'install_packages',
    description:
      'Install apt and/or npm packages into YOUR per-agent container image. Requires admin approval; fire-and-forget. On approval, the image is rebuilt and the container is restarted automatically.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        apt: { type: 'array', items: { type: 'string' }, description: 'apt packages to install (names only, no version specs or flags)' },
        npm: { type: 'array', items: { type: 'string' }, description: 'npm packages to install globally (names only, no version specs)' },
        reason: { type: 'string', description: 'Why these packages are needed' },
      },
    },
  },
  async handler(args) {
    const apt = (args.apt as string[]) || [];
    const npm = (args.npm as string[]) || [];
    if (apt.length === 0 && npm.length === 0) return err('At least one apt or npm package is required');
    if (apt.length + npm.length > MAX_PACKAGES) return err(`Maximum ${MAX_PACKAGES} packages per request`);

    const invalidApt = apt.find((p) => !APT_RE.test(p));
    if (invalidApt) return err(`Invalid apt package name: "${invalidApt}". Only lowercase letters, digits, and ._+- allowed.`);
    const invalidNpm = npm.find((p) => !NPM_RE.test(p));
    if (invalidNpm) return err(`Invalid npm package name: "${invalidNpm}". No version specs or shell characters.`);

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'install_packages',
        apt,
        npm,
        reason: (args.reason as string) || '',
      }),
    });

    log(`install_packages: ${requestId} → apt=[${apt.join(',')}] npm=[${npm.join(',')}]`);
    return ok(`Package install request submitted. You will be notified when admin approves or rejects.`);
  },
};

export const addMcpServer: McpToolDefinition = {
  tool: {
    name: 'add_mcp_server',
    description:
      'Wire an EXISTING third-party MCP server into YOUR per-agent runtime config — you must already know the exact `command` + `args` to invoke it (e.g. `npx @modelcontextprotocol/server-github`). Requires admin approval; fire-and-forget.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'MCP server name (unique identifier)' },
        command: { type: 'string', description: 'Command to run the MCP server' },
        args: { type: 'array', items: { type: 'string' }, description: 'Command arguments' },
        env: { type: 'object', description: 'Environment variables for the server' },
      },
      required: ['name', 'command'],
    },
  },
  async handler(args) {
    const name = args.name as string;
    const command = args.command as string;
    if (!name || !command) return err('name and command are required');

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'add_mcp_server',
        name,
        command,
        args: (args.args as string[]) || [],
        env: (args.env as Record<string, string>) || {},
      }),
    });

    log(`add_mcp_server: ${requestId} → "${name}" (${command})`);
    return ok(`MCP server request submitted. You will be notified when admin approves or rejects.`);
  },
};

export const installPlugin: McpToolDefinition = {
  tool: {
    name: 'install_plugin',
    description:
      'Install a Claude Code plugin into your agent group. Plugins are loaded by the SDK at session init via container.json:plugins. Requires admin approval; fire-and-forget. On approval, the plugin is enabled in container.json, the container is restarted, and the SDK clones + installs the marketplace at next spawn. ' +
      'plugin_spec is "name@marketplace" (the format the SDK uses). If the marketplace is not yet registered for this group, supply a `source` parameter — JSON matching extraKnownMarketplaces source schema (e.g. { "source": "github", "repo": "owner/repo", "ref": "main" }). For private github repos, the operator must have run /setup-private-plugins on the host first to wire the OneCLI vault entry.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        plugin_spec: { type: 'string', description: 'Plugin in "name@marketplace" format (e.g. "fmt@acme")' },
        source: {
          type: 'object',
          description: 'Optional inline source for the marketplace if not yet registered. Must match SDK extraKnownMarketplaces schema. Skip if marketplace already registered for the group.',
        },
        reason: { type: 'string', description: 'Why this plugin is needed' },
      },
      required: ['plugin_spec'],
    },
  },
  async handler(args) {
    const pluginSpec = args.plugin_spec as string;
    if (!pluginSpec || typeof pluginSpec !== 'string') return err('plugin_spec is required and must be a string');
    if (!pluginSpec.includes('@')) return err('plugin_spec must be in "name@marketplace" format');

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'install_plugin',
        plugin_spec: pluginSpec,
        source: args.source ?? null,
        reason: (args.reason as string) || '',
      }),
    });

    log(`install_plugin: ${requestId} → "${pluginSpec}"${args.source ? ' (with inline source)' : ''}`);
    return ok(`Plugin install request submitted. You will be notified when admin approves or rejects.`);
  },
};

export const uninstallPlugin: McpToolDefinition = {
  tool: {
    name: 'uninstall_plugin',
    description:
      'Disable a previously-installed plugin from your agent group. Requires admin approval; fire-and-forget. The marketplace registration stays so other plugins from the same source remain installable. plugin_spec is "name@marketplace".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        plugin_spec: { type: 'string', description: 'Plugin in "name@marketplace" format' },
        reason: { type: 'string', description: 'Why this plugin should be removed' },
      },
      required: ['plugin_spec'],
    },
  },
  async handler(args) {
    const pluginSpec = args.plugin_spec as string;
    if (!pluginSpec || typeof pluginSpec !== 'string') return err('plugin_spec is required and must be a string');
    if (!pluginSpec.includes('@')) return err('plugin_spec must be in "name@marketplace" format');

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'uninstall_plugin',
        plugin_spec: pluginSpec,
        reason: (args.reason as string) || '',
      }),
    });

    log(`uninstall_plugin: ${requestId} → "${pluginSpec}"`);
    return ok(`Plugin uninstall request submitted. You will be notified when admin approves or rejects.`);
  },
};

registerTools([installPackages, addMcpServer, installPlugin, uninstallPlugin]);
