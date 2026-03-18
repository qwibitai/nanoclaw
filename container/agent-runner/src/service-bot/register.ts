// MCP tool registration — adds all Service Bot tools to a NanoClaw MCP server.
// This file is designed to be imported into NanoClaw's ipc-mcp-stdio.ts on XPS.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sshExec } from './ssh.js';
import { createGitHubClient } from './github.js';
import { botStatus, readLogs, readFile, listIssues } from './observe.js';
import { searchLogs, inspectConfig } from './diagnose.js';
import { editFile, dockerCommand, createIssue, runCommand } from './act.js';
import { chubSearch, chubGet, chubExec } from './chub.js';

function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }] };
}

/**
 * Register all 10 Service Bot tools on the given MCP server.
 * Call this from ipc-mcp-stdio.ts after creating the McpServer.
 */
export function registerServiceBotTools(
  server: McpServer,
  githubToken?: string,
) {
  const github = githubToken ? createGitHubClient(githubToken) : null;

  // ─── Observe ─────────────────────────────────────────────

  server.tool(
    'bot_status',
    'Get the running status of a managed bot (DB or Nook). Returns container state, uptime, and health info.',
    { bot: z.string().describe('Bot identifier: "db" or "nook"') },
    async ({ bot }) => text(await botStatus(bot, sshExec)),
  );

  server.tool(
    'read_logs',
    'Read recent log lines from a bot container or bridge service.',
    {
      bot: z.string().describe('Bot identifier: "db" or "nook"'),
      lines: z.number().optional().describe('Number of log lines (default 50, max 500)'),
      service: z.enum(['main', 'bridge']).optional().describe('"main" for Docker container, "bridge" for Nook LettaBot service'),
    },
    async ({ bot, lines, service }) =>
      text(await readLogs(bot, sshExec, { lines, service })),
  );

  server.tool(
    'read_file',
    'Read a file from a managed bot host. Uses sudo for root-owned files on DB.',
    {
      bot: z.string().describe('Bot identifier: "db" or "nook"'),
      path: z.string().describe('Absolute file path on the target host'),
    },
    async ({ bot, path }) => text(await readFile(bot, path, sshExec)),
  );

  server.tool(
    'list_issues',
    'List GitHub Issues for a managed bot repository.',
    {
      bot: z.string().describe('Bot identifier: "db" or "nook"'),
      labels: z.string().optional().describe('Comma-separated label filter'),
      state: z.enum(['open', 'closed', 'all']).optional().describe('Issue state (default: open)'),
    },
    async ({ bot, labels, state }) => {
      if (!github) return text('Error: GITHUB_TOKEN not configured.');
      return text(await listIssues(bot, github, { labels, state }));
    },
  );

  // ─── Diagnose ────────────────────────────────────────────

  server.tool(
    'search_logs',
    'Search bot logs for a specific pattern using grep.',
    {
      bot: z.string().describe('Bot identifier: "db" or "nook"'),
      pattern: z.string().describe('Grep pattern (basic regex)'),
      lines: z.number().optional().describe('Log lines to search through (default 200, max 5000)'),
      context: z.number().optional().describe('Context lines around matches (default 2)'),
    },
    async ({ bot, pattern, lines, context }) =>
      text(await searchLogs(bot, pattern, sshExec, { lines, context })),
  );

  server.tool(
    'inspect_config',
    'Read and display the primary configuration for a managed bot.',
    {
      bot: z.string().describe('Bot identifier: "db" or "nook"'),
    },
    async ({ bot }) => text(await inspectConfig(bot, sshExec)),
  );

  // ─── Act ─────────────────────────────────────────────────

  server.tool(
    'edit_file',
    'Write content to a file on a bot host, creating a backup first. Verifies the write succeeded.',
    {
      bot: z.string().describe('Bot identifier: "db" or "nook"'),
      path: z.string().describe('Absolute file path on the target host'),
      content: z.string().describe('New file content'),
    },
    async ({ bot, path, content }) =>
      text(await editFile(bot, path, content, sshExec)),
  );

  server.tool(
    'docker_command',
    'Execute a scoped Docker command on a managed bot container. Only restart/stop/start/exec are allowed.',
    {
      bot: z.string().describe('Bot identifier: "db" or "nook"'),
      action: z.string().describe('Docker action: "restart", "stop", "start", or "exec"'),
      exec_command: z.string().optional().describe('Command to run inside container (required for exec)'),
    },
    async ({ bot, action, exec_command }) =>
      text(await dockerCommand(bot, action, sshExec, { execCommand: exec_command })),
  );

  server.tool(
    'create_issue',
    'Create a GitHub Issue on a managed bot repository. Auto-adds "bot-reported" label.',
    {
      bot: z.string().describe('Bot identifier: "db" or "nook"'),
      title: z.string().describe('Issue title'),
      body: z.string().describe('Issue body (Markdown)'),
      labels: z.string().optional().describe('Comma-separated labels'),
    },
    async ({ bot, title, body, labels }) => {
      if (!github) return text('Error: GITHUB_TOKEN not configured.');
      return text(await createIssue(bot, title, body, github, { labels }));
    },
  );

  server.tool(
    'run_command',
    'Run an arbitrary shell command on a managed bot host via SSH. The command is visible in the conversation.',
    {
      bot: z.string().describe('Bot identifier: "db" or "nook"'),
      command: z.string().describe('Shell command to execute'),
      timeout: z.number().optional().describe('Command timeout in seconds (default 30)'),
    },
    async ({ bot, command, timeout }) =>
      text(await runCommand(bot, command, sshExec, { timeout })),
  );

  // ─── Context Hub (chub) ──────────────────────────────────

  server.tool(
    'chub_search',
    'Search Context Hub for LLM-optimized docs and skills. Use before writing code against any third-party API/SDK to get curated reference docs instead of guessing.',
    {
      query: z.string().describe('Search query (e.g., "openai", "slack sdk", "openclaw"). Empty string lists all.'),
      tags: z.string().optional().describe('Filter by tags (comma-separated, e.g., "official,internal")'),
      lang: z.string().optional().describe('Filter by language: py, js, ts, rb, cs'),
      limit: z.number().optional().describe('Max results (default 20, max 50)'),
    },
    async ({ query, tags, lang, limit }) =>
      text(await chubSearch(query, chubExec, { tags, lang, limit })),
  );

  server.tool(
    'chub_get',
    'Fetch a specific doc or skill from Context Hub by ID. Returns the full curated content. Use after chub_search to retrieve a specific result.',
    {
      id: z.string().describe('Doc or skill ID (e.g., "openai/gpt4", "neuronbox/openclaw-framework")'),
      lang: z.string().optional().describe('Language variant: py, js, ts, rb, cs (required for multi-language docs)'),
      full: z.boolean().optional().describe('Fetch all files including reference files, not just the entry point'),
    },
    async ({ id, lang, full }) =>
      text(await chubGet(id, chubExec, { lang, full })),
  );
}
