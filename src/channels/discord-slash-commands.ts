/**
 * Discord slash commands — administrative surface for managing nanoclaw:
 *   /deploy           — pull main, build, rebuild image if needed, restart
 *   /update-container — audit Dockerfile package drift, agent opens PR
 *   /update-plugins   — git pull every ~/plugins/<name>
 *
 * Runs a dedicated discord.js Client parallel to @chat-adapter/discord's
 * chat client, gated on ENABLE_DISCORD_SLASH_COMMANDS=1. Scoped via
 * DISCORD_SLASH_CHANNEL_IDS (comma-separated channel ids) so accidental
 * invocations in random channels don't run deploy commands.
 *
 * /update-container injects a synthetic chat message into the router
 * (routeInbound) carrying an audit prompt. The agent (running in a
 * container for the receiving messaging group) runs the audit, presents
 * the drift table, asks which packages to bump, clones the repo to a
 * writable temp dir, edits the Dockerfile, opens a PR, and stops. The
 * container-rebuild watcher picks up the PR on merge and rebuilds the
 * image automatically.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  type ChatInputCommandInteraction,
  type Interaction,
  type TextChannel,
} from 'discord.js';

import { REPO_ROOT } from '../config.js';
import { startContainerRebuildWatcher, stopContainerRebuildWatcher } from '../container-rebuild-watcher.js';
import { log } from '../log.js';
import { runPluginUpdates } from '../plugin-updater.js';
import { routeInbound } from '../router.js';

const COMMANDS = [
  { name: 'deploy', description: 'Pull, build, and restart NanoClaw v2 from main' },
  { name: 'update-container', description: 'Audit container package drift and open a bump PR' },
  { name: 'update-plugins', description: 'Run git pull on all ~/plugins repos now' },
];

const DEPLOY_SCRIPT = path.resolve(REPO_ROOT, 'scripts', 'deploy.sh');
const DEPLOY_LOG = path.resolve(REPO_ROOT, 'logs', 'deploy.log');
const DEPLOY_STATUS = path.resolve(REPO_ROOT, 'logs', 'deploy-status.json');
let client: Client | null = null;

async function registerCommands(botToken: string, clientId: string, guildId: string): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(botToken);
  try {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: COMMANDS });
    log.info('Discord slash commands registered', { guildId, count: COMMANDS.length });
  } catch (err) {
    log.error('Failed to register Discord slash commands', { err });
  }
}

function allowedChannels(): Set<string> {
  const raw = process.env.DISCORD_SLASH_CHANNEL_IDS || '';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function channelIsAllowed(interaction: ChatInputCommandInteraction): boolean {
  const ids = allowedChannels();
  if (ids.size === 0) return false;
  if (interaction.channelId && ids.has(interaction.channelId)) return true;
  const ch = interaction.channel;
  if (ch && 'isThread' in ch && typeof ch.isThread === 'function' && ch.isThread()) {
    const parentId = (ch as { parentId?: string | null }).parentId;
    if (parentId && ids.has(parentId)) return true;
  }
  return false;
}

function deployChannelId(): string | null {
  const explicit = process.env.DISCORD_DEPLOY_CHANNEL_ID?.trim();
  if (explicit) return explicit;
  const ids = allowedChannels();
  const first = ids.values().next().value;
  return first ?? null;
}

/**
 * Get the parent channel id for thread interactions, or the channel id
 * itself when not in a thread. Injected synthetic messages must route to
 * the parent channel (threads on the Discord side aren't first-class to
 * the router today — messages land on the parent messaging_group).
 */
function getInteractionParentId(interaction: ChatInputCommandInteraction): string | null {
  const ch = interaction.channel;
  if (ch && 'isThread' in ch && typeof ch.isThread === 'function' && ch.isThread()) {
    return (ch as { parentId?: string | null }).parentId ?? null;
  }
  return interaction.channelId ?? null;
}

function spawnDetachedLogged(script: string): void {
  const logFd = fs.openSync(DEPLOY_LOG, 'a');
  const child = spawn('bash', [script], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  fs.closeSync(logFd);
  log.info('Detached deploy spawned', { pid: child.pid });
}

interface DeployStatus {
  status?: 'ok' | 'failed';
  step?: string;
  error?: string;
  mtimeMs: number;
}

function readDeployStatus(): DeployStatus | null {
  try {
    const raw = fs.readFileSync(DEPLOY_STATUS, 'utf-8');
    const { mtimeMs } = fs.statSync(DEPLOY_STATUS);
    return { ...(JSON.parse(raw) as Omit<DeployStatus, 'mtimeMs'>), mtimeMs };
  } catch {
    return null;
  }
}

function consumeDeployStatus(): void {
  try {
    fs.unlinkSync(DEPLOY_STATUS);
  } catch {
    /* ignore — racy unlink is fine */
  }
}

function formatFailure(status: DeployStatus): string {
  return `Deploy failed at **${status.step ?? 'unknown'}**: ${status.error ?? 'no detail'}`;
}

/**
 * Poll deploy-status.json for pre-restart failures. If deploy succeeds,
 * the service restarts mid-poll — announceDeployStatus on the next boot
 * picks up the "ok" status and posts success.
 */
function pollDeployStatus(interaction: ChatInputCommandInteraction): void {
  const startTime = Date.now();
  let stopped = false;

  const poll = async (): Promise<void> => {
    if (stopped) return;
    const status = readDeployStatus();
    if (status && status.mtimeMs >= startTime) {
      if (status.status === 'failed') {
        stopped = true;
        await interaction.followUp({ content: formatFailure(status) });
        consumeDeployStatus();
        return;
      }
      if (status.status === 'ok') {
        stopped = true;
        return;
      }
    }
    if (Date.now() - startTime > 120_000) {
      stopped = true;
      return;
    }
    setTimeout(() => void poll(), 2_000);
  };
  setTimeout(() => void poll(), 2_000);
}

/**
 * One-shot at boot: if deploy-status.json was written in the last 5 min,
 * post the outcome (paired with pollDeployStatus which catches failures
 * *before* restart).
 */
async function announceDeployStatus(): Promise<void> {
  const status = readDeployStatus();
  if (!status) return;
  if (Date.now() - status.mtimeMs > 300_000) return;
  const channelId = deployChannelId();
  if (!channelId) return;
  const textChannel = await getTextChannel(channelId);
  if (!textChannel) return;
  if (status.status === 'ok') {
    await textChannel.send('Deploy complete — service is up.');
  } else if (status.status === 'failed') {
    await textChannel.send(formatFailure(status));
  }
  consumeDeployStatus();
}

async function getTextChannel(channelId: string): Promise<TextChannel | null> {
  if (!client) return null;
  try {
    const ch = await client.channels.fetch(channelId);
    if (!ch || !('send' in ch)) return null;
    return ch as TextChannel;
  } catch {
    return null;
  }
}

async function handleDeploy(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.reply({ content: 'Deploying v2: pulling main, building, restarting…' });
  if (!fs.existsSync(DEPLOY_SCRIPT)) {
    await interaction.followUp({ content: `Deploy script missing at ${DEPLOY_SCRIPT}` });
    return;
  }
  spawnDetachedLogged(DEPLOY_SCRIPT);
  pollDeployStatus(interaction);
}

async function handleUpdatePlugins(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.reply({ content: 'Running git pull on all ~/plugins…' });
  try {
    const results = await runPluginUpdates();
    if (results.length === 0) {
      await interaction.followUp({ content: 'No plugins found in ~/plugins.' });
      return;
    }
    const lines = results.map((r) => {
      if (r.error) return `✗ ${r.plugin}: ${r.error}`;
      return r.changed ? `↑ ${r.plugin}: updated` : `· ${r.plugin}: up to date`;
    });
    const changedCount = results.filter((r) => r.changed).length;
    const errCount = results.filter((r) => r.error).length;
    const summary = `${changedCount} updated, ${errCount} failed, ${results.length - changedCount - errCount} up to date`;
    const body = [summary, '', ...lines].join('\n').slice(0, 1900);
    await interaction.followUp({ content: `\`\`\`\n${body}\n\`\`\`` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await interaction.followUp({ content: `Plugin update failed: ${msg.slice(0, 1800)}` });
  }
}

const UPDATE_CONTAINER_PROMPT = [
  'Run the container update audit.',
  '',
  '## Step 1 — Detect Dockerfile package drift',
  'Read /workspace/project/container/Dockerfile and extract every package install. /workspace/project is READ-ONLY — you cannot edit it in place (see Step 4).',
  '- npm/pnpm: lines in `npm install -g` or `pnpm install -g`. Both pinned (`pkg@x.y.z` or `pkg@${ARG}`) AND unpinned (no version) — report both.',
  '- pip: lines in `pip install`. Both pinned (`pkg==x.y.z`) AND unpinned — report both.',
  '- ARG: lines like `ARG PACKAGE_VERSION=x.y.z` (many pins in v2 are indirected via ARG — resolve to the package name by looking at which install line references the ARG).',
  '',
  'For each PINNED package, check the latest available version:',
  '- npm: `npm view <pkg> version`',
  '- pip: `curl -s https://pypi.org/pypi/<pkg>/json | jq -r .info.version`',
  '- GitHub release ARGs: `gh release view --repo <owner>/<repo> --json tagName -q .tagName` for RENDER_VERSION → render-oss/cli, RAILWAY_VERSION → railwayapp/cli, SUPABASE_VERSION → supabase/cli, MNEMON_VERSION → mnemon-dev/mnemon.',
  '',
  'For each UNPINNED package, also check the latest version and report with status ❓ unpinned. These drift on every rebuild without attention.',
  '',
  '## Step 2 — Detect upstream-synced file drift',
  'Read /workspace/plugins/bootstrap/plugins/workflow/skills/team-qa/references/CODEX-SOURCES.md to find verbatim copies of files from openai/codex-plugin-cc and their pinned upstream commit SHAs (stored as 7-char prefixes).',
  '',
  'For each entry, fetch the latest upstream 7-char SHA:',
  '`gh api "repos/openai/codex-plugin-cc/commits?path=<upstream-path>&per_page=1" --jq \'.[0].sha[0:7]\'`',
  '',
  'If it differs from the pinned SHA, the file has drifted.',
  '',
  '## Step 3 — Present a unified audit table',
  '| Item | Kind | Current | Latest | Status |',
  'Status: ✅ up to date, ⬆️ outdated, ❓ unpinned.',
  'Below the table, summarize: "N outdated, M unpinned: <names>".',
  'Then ask: "Update all, specific ones, or skip?"',
  '',
  '## Step 4 — Apply updates (after user confirms)',
  '',
  '### Dockerfile package bumps',
  '/workspace/project is READ-ONLY. Clone the repo to a writable temp dir:',
  '1. `rm -rf /tmp/nanoclaw-update && gh repo clone davekim917/nanoclaw /tmp/nanoclaw-update`',
  '2. Edit /tmp/nanoclaw-update/container/Dockerfile in place — update the pinned ARGs / package versions. For ARG-indirected pins, bump the `ARG ...=x.y.z` line. For inline pins, bump `pkg@x.y.z`.',
  '3. `cd /tmp/nanoclaw-update && git checkout -b chore/container-pins-$(date +%Y%m%d-%H%M)`',
  '4. `git add container/Dockerfile && git commit -m "chore(container): bump <packages> to latest"`',
  '5. `git push -u origin HEAD`',
  '6. `gh pr create --title "chore(container): bump <packages>" --body "..." --base main`',
  '7. STOP. Report the PR URL back to the chat. Do NOT run `gh pr merge` — Dave reviews and merges manually via the GitHub UI.',
  '',
  "After Dave merges, the host's container-rebuild watcher (src/container-rebuild-watcher.ts) will detect the merge within ~60s, run `git pull && container/build.sh v2`, and post the rebuild result to Discord. No timer wait, no manual step.",
  '',
  '### Upstream-synced file resync (Codex prompts/schemas)',
  '/workspace/plugins/bootstrap is mounted READ-ONLY, so push via the upstream repo:',
  '1. /workspace/plugins/codex is mounted with the latest pulled by nanoclaw-plugins-update.timer — read the new file content directly from there (e.g. /workspace/plugins/codex/plugins/codex/prompts/adversarial-review.md).',
  '2. Get the new 7-char SHA: `gh api "repos/openai/codex-plugin-cc/commits?path=<path>&per_page=1" --jq \'.[0].sha[0:7]\'`',
  '3. `rm -rf /tmp/bootstrap-update && gh repo clone davekim917/bootstrap /tmp/bootstrap-update`',
  '4. Copy the new file content into /tmp/bootstrap-update/plugins/workflow/skills/team-qa/references/<local-name>',
  '5. CRITICAL — verify the resynced file still contains all template placeholders ({{TARGET_LABEL}}, {{USER_FOCUS}}, {{REVIEW_INPUT}}). If any are missing, ABORT and report — Validator E depends on these markers.',
  "6. Update the SHA pin row in CODEX-SOURCES.md to the new 7-char SHA and today's date.",
  '7. Bump plugins/workflow/.claude-plugin/plugin.json `version` (patch bump for resync).',
  '8. `cd /tmp/bootstrap-update && git checkout -b chore/codex-resync-$(date +%Y%m%d-%H%M)`',
  '9. `git add -A && git commit -m "chore(team-qa): resync codex <files> to <short-sha>"`',
  '10. `git push -u origin HEAD && gh pr create --title "..." --body "..." --base main`',
  '11. STOP. Report the PR URL. Do NOT run `gh pr merge` — Dave reviews and merges. After merge, nanoclaw-plugins-update.timer pulls within the hour and the resync goes live.',
  '',
  '## Step 5 — Schema migration verification (if MNEMON_VERSION bumped)',
  'Spin up a temp copy of one enabled mnemon store DB against the new binary,',
  'run `mnemon status --store <store>` as a smoke query.',
  'If it errors with schema incompatibility, ABORT the bump and report the diagnostic.',
  'Gate the PR on this check passing.',
  '',
  '## Important notes',
  '- Show diffs before committing each repo. Ask for explicit approval per repo.',
  '- The two repos (nanoclaw + bootstrap) are independent — separate PRs, separate manual merges.',
  '- If everything is up to date, say so in one line and stop. Do not create empty PRs.',
  '- DO NOT run `gh pr merge` — merging is a manual human step.',
  '- DO NOT run `./container/build.sh` from inside the container (you cannot run docker from inside a container, and the host watcher handles rebuild automatically post-merge).',
].join('\n');

async function handleUpdateContainer(interaction: ChatInputCommandInteraction): Promise<void> {
  if (interaction.channel && 'isThread' in interaction.channel && interaction.channel.isThread()) {
    await interaction.reply({
      content: 'Run /update-container in the parent channel, not inside a thread.',
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({ content: 'Auditing container packages and synced upstream files…' });
  const reply = await interaction.fetchReply();

  const parentChannelId = getInteractionParentId(interaction);
  if (!parentChannelId) {
    await interaction.followUp({ content: 'Could not resolve channel id for injection.' });
    return;
  }
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.followUp({ content: '/update-container must be run in a guild channel, not a DM.' });
    return;
  }
  // Discord chat-sdk adapter format: bare snowflakes fail downstream with
  // "Invalid Discord thread ID".
  const encodeId = (...parts: string[]): string => ['discord', guildId, parentChannelId, ...parts].join(':');
  const platformId = encodeId();

  // In-thread mention-sticky engages without @mention, so the user can just
  // reply "yes" inside the audit thread.
  const AUTO_ARCHIVE_24H = 1440;
  let threadId: string | null = null;
  try {
    const thread = await reply.startThread({ name: 'Container update', autoArchiveDuration: AUTO_ARCHIVE_24H });
    threadId = encodeId(thread.id);
  } catch (err) {
    log.warn('Failed to open audit thread, falling back to channel root', {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  const syntheticId = `slash-update-container-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const content = {
    text: UPDATE_CONTAINER_PROMPT,
    sender: interaction.user.username,
    senderId: interaction.user.id,
    senderName: interaction.user.username,
    isMention: true,
  };

  try {
    await routeInbound({
      channelType: 'discord',
      platformId,
      threadId,
      message: {
        id: syntheticId,
        kind: 'chat-sdk',
        content: JSON.stringify(content),
        timestamp: new Date().toISOString(),
        isMention: true,
      },
    });
  } catch (err) {
    log.error('/update-container injection failed', { err });
    await interaction.followUp({
      content: `Failed to start audit: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

async function onInteraction(interaction: Interaction): Promise<void> {
  if (!interaction.isChatInputCommand()) return;

  if (!channelIsAllowed(interaction)) {
    await interaction.reply({
      content: 'This channel is not in `DISCORD_SLASH_CHANNEL_IDS`. Admin commands are scoped.',
      ephemeral: true,
    });
    return;
  }

  try {
    if (interaction.commandName === 'deploy') await handleDeploy(interaction);
    else if (interaction.commandName === 'update-container') await handleUpdateContainer(interaction);
    else if (interaction.commandName === 'update-plugins') await handleUpdatePlugins(interaction);
    else {
      await interaction.reply({ content: `Unknown command: ${interaction.commandName}`, ephemeral: true });
    }
  } catch (err) {
    log.error('Slash command handler threw', { command: interaction.commandName, err });
    try {
      await interaction.followUp({
        content: `Handler error: ${err instanceof Error ? err.message : String(err)}`,
        ephemeral: true,
      });
    } catch {
      /* already replied / no channel */
    }
  }
}

/**
 * Start the slash-command client. No-op unless
 * ENABLE_DISCORD_SLASH_COMMANDS=1 AND DISCORD_BOT_TOKEN is set.
 * Also boots the container-rebuild watcher (which pushes rebuild-complete
 * notifications into the deploy channel).
 */
export async function startDiscordSlashCommands(): Promise<boolean> {
  if (process.env.ENABLE_DISCORD_SLASH_COMMANDS !== '1') {
    log.debug('Discord slash commands disabled — ENABLE_DISCORD_SLASH_COMMANDS != 1');
    return false;
  }
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken) {
    log.warn('Discord slash commands: DISCORD_BOT_TOKEN not set');
    return false;
  }

  client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once('clientReady', async () => {
    log.info('Discord slash-command client ready', { username: client?.user?.username });
    const clientId = client?.user?.id;
    if (clientId) {
      for (const [guildId] of client?.guilds?.cache ?? new Map()) {
        await registerCommands(botToken, clientId, guildId);
      }
    }
    await announceDeployStatus();
    startContainerRebuildWatcher(async (message: string) => {
      const channelId = deployChannelId();
      if (!channelId) return;
      const textChannel = await getTextChannel(channelId);
      if (textChannel) {
        await textChannel.send(message);
      }
    });
  });

  client.on('interactionCreate', (interaction) => {
    onInteraction(interaction).catch((err) => {
      log.error('Unhandled slash-command error', { err });
    });
  });

  await client.login(botToken);
  return true;
}

export async function stopDiscordSlashCommands(): Promise<void> {
  stopContainerRebuildWatcher();
  if (client) {
    try {
      await client.destroy();
    } catch {
      /* ignore */
    }
    client = null;
  }
}
