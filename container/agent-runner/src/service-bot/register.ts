// MCP tool registration — adds all Service Bot tools to a NanoClaw MCP server.
// This file is designed to be imported into NanoClaw's ipc-mcp-stdio.ts on XPS.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sshExec } from './ssh.js';
import { createGitHubClient } from './github.js';
import { botStatus, readLogs, readFile, listIssues } from './observe.js';
import { searchLogs, inspectConfig } from './diagnose.js';
import { editFile, dockerCommand, createIssue, runCommand } from './act.js';
import { initRegistry, refreshConfigs } from './config.js';
import { chubSearch, chubGet, chubExec } from './chub.js';
import { readOwnConversations } from './self.js';
import { transcribeAudio } from './audio.js';


function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }] };
}

/**
 * Register all Service Bot tools on the given MCP server.
 * Call this from ipc-mcp-stdio.ts after creating the McpServer.
 * Initializes the bot registry for dynamic config loading.
 */
export async function registerServiceBotTools(
  server: McpServer,
  githubToken?: string,
) {
  const github = githubToken ? createGitHubClient(githubToken) : null;

  // Initialize registry (fetches configs from API, falls back to cache)
  await initRegistry();

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

  // ─── Audio Processing ────────────────────────────────────

  server.tool(
    'transcribe_audio',
    'Transcribe audio from a Telegram voice message or file. Converts speech to text using Groq Whisper API.',
    {
      telegramFileId: z.string().describe('Telegram file_id from voice message'),
      audioUrl: z.string().optional().describe('Direct URL to audio file (optional if telegramFileId provided)'),
    },
    async ({ telegramFileId, audioUrl }) => {
      const url = audioUrl || '';
      const result = await transcribeAudio(url, telegramFileId);
      return text(result);
    },
  );

  // ─── Self-Observation ────────────────────────────────────

  server.tool(
    'read_own_conversations',
    'Read X\'s own conversation history across all channels (Slack + Telegram). Queries the messages database directly. Used for cross-channel context awareness.',
    {
      channel: z.enum(['slack', 'telegram']).optional().describe('Filter by channel. Omit to get all channels.'),
      lines: z.number().optional().describe('Number of messages to return (default 20, max 100)'),
      search: z.string().optional().describe('Search term to filter messages by content'),
      hours: z.number().optional().describe('How many hours back to search (default 4)'),
    },
    async ({ channel, lines, search, hours }) =>
      text(await readOwnConversations(sshExec, { channel, lines, search, hours })),
  );

  // ─── Registry Management ──────────────────────────────────

  server.tool(
    'refresh_configs',
    'Refresh bot configurations from the central registry API. Use after onboarding a new bot or updating a bot\'s config in the registry. Returns a diff of added/removed bots.',
    {},
    async () => {
      const result = await refreshConfigs();
      const lines = [
        `Loaded ${result.botsLoaded} bot configs (source: ${result.source})`,
      ];
      if (result.added.length > 0) lines.push(`Added: ${result.added.join(', ')}`);
      if (result.removed.length > 0) lines.push(`Removed: ${result.removed.join(', ')}`);
      if (result.added.length === 0 && result.removed.length === 0) {
        lines.push('No changes detected.');
      }
      return text(lines.join('\n'));
    },
  );

  // ─── Notice Board ─────────────────────────────────────────
  // Notice tools (read_notices, acknowledge_notice, post_notice) have been
  // moved to the standalone bot-dashboard-mcp server. All bots now consume
  // notices via that MCP server instead of baked-in tools.
}
