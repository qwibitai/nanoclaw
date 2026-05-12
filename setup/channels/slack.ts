/**
 * Slack channel flow for setup:auto.
 *
 * `runSlackChannel(displayName)` owns the full branch from creating a
 * Slack app through the welcome DM:
 *
 *   1. Walk through creating a Slack app (api.slack.com/apps) — scopes,
 *      event subscriptions, and signing secret
 *   2. Paste the bot token + signing secret (clack password prompts)
 *   3. Validate via auth.test → resolves workspace + bot identity
 *   4. Install the adapter (setup/add-slack.sh, non-interactive)
 *   5. Ask for the operator's Slack user ID
 *   6. conversations.open to get the DM channel ID
 *   7. Ask for the messaging-agent name (defaulting to "Nano")
 *   8. Wire the agent via scripts/init-first-agent.ts
 *
 * The welcome DM is sent via outbound delivery (chat.postMessage), which
 * works without Event Subscriptions being configured. The user sees the
 * greeting in Slack immediately; inbound replies require webhooks, so the
 * post-install note covers that.
 *
 * All output obeys the three-level contract. See docs/setup-flow.md.
 */
import * as p from '@clack/prompts';
import k from 'kleur';

import * as setupLog from '../logs.js';
import { BACK_TO_CHANNEL_SELECTION, type ChannelFlowResult } from '../lib/back-nav.js';
import { brightSelect } from '../lib/bright-select.js';
import { openUrl } from '../lib/browser.js';
import { isHeadless } from '../platform.js';
import { askOperatorRole } from '../lib/role-prompt.js';
import { ensureAnswer, fail, runQuietChild } from '../lib/runner.js';
import { readEnvKey } from '../environment.js';
import { accentGreen, fmtDuration, note, wrapForGutter } from '../lib/theme.js';

const SLACK_API = 'https://slack.com/api';
const SLACK_APPS_URL = 'https://api.slack.com/apps';
const DEFAULT_AGENT_NAME = 'Nano';

interface WorkspaceInfo {
  teamName: string;
  teamId: string;
  botName: string;
  botUserId: string;
}

export async function runSlackChannel(displayName: string): Promise<ChannelFlowResult> {
  const intro = await walkThroughAppCreation();
  if (intro === 'back') return BACK_TO_CHANNEL_SELECTION;

  const token = await collectBotToken();
  const signingSecret = await collectSigningSecret();
  const info = await validateSlackToken(token);

  const install = await runQuietChild(
    'slack-install',
    'bash',
    ['setup/add-slack.sh'],
    {
      running: `Connecting Slack to @${info.botName} (${info.teamName})…`,
      done: 'Slack adapter installed.',
    },
    {
      env: {
        SLACK_BOT_TOKEN: token,
        SLACK_SIGNING_SECRET: signingSecret,
      },
      extraFields: {
        BOT_NAME: info.botName,
        TEAM_NAME: info.teamName,
        TEAM_ID: info.teamId,
      },
    },
  );
  if (!install.ok) {
    await fail(
      'slack-install',
      "Couldn't connect Slack.",
      'See logs/setup-steps/ for details, then retry setup.',
    );
  }

  const pastedUserId = await collectSlackUserId();
  const dmOutcome = await openDmChannel(token, pastedUserId, displayName);
  if (dmOutcome === BACK_TO_CHANNEL_SELECTION) return BACK_TO_CHANNEL_SELECTION;
  const { userId: ownerUserId, dmChannelId } = dmOutcome;
  const platformId = `slack:${dmChannelId}`;

  const role = await askOperatorRole('Slack');
  setupLog.userInput('slack_role', role);

  const agentName = await resolveAgentName();

  const init = await runQuietChild(
    'init-first-agent',
    'pnpm',
    [
      'exec', 'tsx', 'scripts/init-first-agent.ts',
      '--channel', 'slack',
      '--user-id', `slack:${ownerUserId}`,
      '--platform-id', platformId,
      '--display-name', displayName,
      '--agent-name', agentName,
      '--role', role,
    ],
    {
      running: `Wiring ${agentName} to your Slack DMs…`,
      done: 'Agent wired.',
    },
    {
      extraFields: {
        CHANNEL: 'slack',
        AGENT_NAME: agentName,
        PLATFORM_ID: platformId,
      },
    },
  );
  if (!init.ok) {
    await fail(
      'init-first-agent',
      `Couldn't finish connecting ${agentName}.`,
      'You can retry later with `/init-first-agent` in Claude Code.',
    );
  }

  showPostInstallChecklist(info);
}

async function walkThroughAppCreation(): Promise<'continue' | 'back'> {
  // Bright-white ANSI overrides the surrounding brand-cyan from `note()`'s
  // per-line formatter so the URL stands out against the rest of the body.
  const linkBlock = isHeadless()
    ? [`\x1b[97mGet started: ${SLACK_APPS_URL}\x1b[39m`, '']
    : [];

  note(
    [
      "You'll create a Slack app that the assistant talks through.",
      "Free and stays inside the workspaces you pick.",
      '',
      ...linkBlock,
      '  1. Create a new app "From scratch", name it, pick a workspace',
      '  2. OAuth & Permissions → add Bot Token Scopes:',
      '     • im:write, im:history',
      '     • channels:read, channels:history',
      '     • groups:read, groups:history',
      '     • chat:write',
      '     • users:read',
      '     • reactions:write',
      '  3. App Home → enable "Messages Tab" and "Allow users to send',
      '     slash commands and messages from the messages tab"',
      '  4. Basic Information → copy the "Signing Secret"',
      '  5. Install to Workspace → copy the "Bot User OAuth Token" (xoxb-…)',
    ].join('\n'),
    'Create a Slack app',
  );

  // Back-aware gate replacing the old `confirmThenOpen` "Press Enter to open
  // Slack app settings" so users can bail out of Slack before we open the
  // browser or ask for tokens.
  const choice = ensureAnswer(await brightSelect<'open' | 'back'>({
    message: 'Open Slack app settings in your browser?',
    options: [
      { value: 'open', label: 'Open Slack app settings' },
      { value: 'back', label: '← Back to channel selection' },
    ],
    initialValue: 'open',
  }));
  if (choice === 'back') return 'back';
  if (!isHeadless()) openUrl(SLACK_APPS_URL);

  ensureAnswer(
    await p.confirm({
      message: 'Got your bot token and signing secret?',
      initialValue: true,
    }),
  );
  return 'continue';
}

async function collectBotToken(): Promise<string> {
  const existing = readEnvKey('SLACK_BOT_TOKEN');
  if (existing && existing.startsWith('xoxb-') && existing.length >= 24) {
    const reuse = ensureAnswer(await p.confirm({
      message: `Found an existing Slack bot token (${existing.slice(0, 10)}…). Use it?`,
      initialValue: true,
    }));
    if (reuse) {
      setupLog.userInput('slack_bot_token', 'reused-existing');
      return existing;
    }
  }

  const answer = ensureAnswer(
    await p.password({
      message: 'Paste your Slack bot token',
      clearOnError: true,
      validate: (v) => {
        const t = (v ?? '').trim();
        if (!t) return 'Token is required';
        if (!t.startsWith('xoxb-')) return 'Bot tokens start with xoxb-';
        if (t.length < 24) return "That's shorter than a real Slack bot token";
        return undefined;
      },
    }),
  );
  const token = (answer as string).trim();
  setupLog.userInput(
    'slack_bot_token',
    `${token.slice(0, 10)}…${token.slice(-4)}`,
  );
  return token;
}

async function collectSigningSecret(): Promise<string> {
  const existing = readEnvKey('SLACK_SIGNING_SECRET');
  if (existing && /^[a-f0-9]{16,}$/i.test(existing)) {
    const reuse = ensureAnswer(await p.confirm({
      message: 'Found an existing Slack signing secret. Use it?',
      initialValue: true,
    }));
    if (reuse) {
      setupLog.userInput('slack_signing_secret', 'reused-existing');
      return existing;
    }
  }

  const answer = ensureAnswer(
    await p.password({
      message: 'Paste your Slack signing secret',
      clearOnError: true,
      validate: (v) => {
        const t = (v ?? '').trim();
        if (!t) return 'Signing secret is required';
        // Slack signing secrets are 32-char hex strings, but newer apps
        // sometimes emit longer variants — leniently require hex only.
        if (!/^[a-f0-9]{16,}$/i.test(t)) {
          return 'Signing secrets are a string of hex characters';
        }
        return undefined;
      },
    }),
  );
  const secret = (answer as string).trim();
  setupLog.userInput(
    'slack_signing_secret',
    `${secret.slice(0, 4)}…${secret.slice(-4)}`,
  );
  return secret;
}

async function validateSlackToken(token: string): Promise<WorkspaceInfo> {
  const s = p.spinner();
  const start = Date.now();
  s.start('Checking your bot token…');
  try {
    const res = await fetch(`${SLACK_API}/auth.test`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
    const data = (await res.json()) as {
      ok?: boolean;
      team?: string;
      team_id?: string;
      user?: string;
      user_id?: string;
      error?: string;
    };
    if (data.ok && data.team && data.user) {
      s.stop(
        `Connected to ${data.team} as @${data.user}. ${k.dim(`(${fmtDuration(Date.now() - start)})`)}`,
      );
      const info: WorkspaceInfo = {
        teamName: data.team,
        teamId: data.team_id ?? '',
        botName: data.user,
        botUserId: data.user_id ?? '',
      };
      setupLog.step('slack-validate', 'success', Date.now() - start, {
        BOT_NAME: info.botName,
        BOT_USER_ID: info.botUserId,
        TEAM_NAME: info.teamName,
        TEAM_ID: info.teamId,
      });
      return info;
    }
    const reason = data.error ?? `HTTP ${res.status}`;
    s.stop(`Slack didn't accept that token: ${reason}`, 1);
    setupLog.step('slack-validate', 'failed', Date.now() - start, {
      ERROR: reason,
    });
    await fail(
      'slack-validate',
      "Slack didn't accept that token.",
      reason === 'invalid_auth' || reason === 'token_revoked'
        ? 'Copy the token again from OAuth & Permissions and retry setup.'
        : `Slack said "${reason}". Check the token scopes and workspace install, then retry.`,
    );
  } catch (err) {
    s.stop(`Couldn't reach Slack. ${k.dim(`(${fmtDuration(Date.now() - start)})`)}`, 1);
    const message = err instanceof Error ? err.message : String(err);
    setupLog.step('slack-validate', 'failed', Date.now() - start, {
      ERROR: message,
    });
    await fail(
      'slack-validate',
      "Couldn't reach Slack.",
      'Check your internet connection and retry setup.',
    );
  }
}

async function collectSlackUserId(): Promise<string> {
  note(
    [
      "To get your Slack member ID:",
      '',
      '  1. In Slack, click your profile picture (bottom left)',
      '  2. Click "Profile"',
      '  3. Click the three dots (⋮) → "Copy member ID"',
    ].join('\n'),
    'Find your Slack user ID',
  );
  const answer = ensureAnswer(
    await p.text({
      message: 'Paste your Slack member ID',
      validate: (v) => {
        const t = (v ?? '').trim();
        if (!t) return 'Member ID is required';
        if (!/^U[A-Z0-9]{8,}$/.test(t)) {
          return "That doesn't look like a Slack member ID (starts with U)";
        }
        return undefined;
      },
    }),
  );
  const id = (answer as string).trim();
  setupLog.userInput('slack_user_id', id);
  return id;
}

interface SlackMember {
  id: string;
  name: string;
  real_name?: string;
  profile?: { display_name?: string; email?: string };
  deleted?: boolean;
  is_bot?: boolean;
}

async function listWorkspaceMembers(token: string): Promise<SlackMember[]> {
  const res = await fetch(`${SLACK_API}/users.list?limit=200`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = (await res.json()) as {
    ok?: boolean;
    members?: SlackMember[];
    error?: string;
  };
  if (!data.ok || !data.members) {
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  return data.members.filter(
    (u) => !u.deleted && !u.is_bot && u.id !== 'USLACKBOT',
  );
}

function scoreMember(u: SlackMember, q: string): number {
  const ql = q.toLowerCase();
  const fields = [
    u.real_name,
    u.profile?.display_name,
    u.name,
    u.profile?.email,
  ]
    .filter((s): s is string => Boolean(s))
    .map((s) => s.toLowerCase());
  let best = 0;
  for (const f of fields) {
    if (f === ql) best = Math.max(best, 100);
    else if (f.startsWith(ql)) best = Math.max(best, 80);
    else if (f.includes(ql)) best = Math.max(best, 50);
  }
  return best;
}

/**
 * Workspace-member lookup for the `user_not_found` fallback. Calls
 * users.list, asks for the user's name/email, and offers a brightSelect
 * over the top matches. Returns the chosen member ID, or null if the
 * user opts out (no matches, none-of-these, or API error).
 */
async function lookupSlackUserId(
  token: string,
  displayName: string,
): Promise<{ id: string; label: string } | 'manual' | 'back'> {
  const s = p.spinner();
  const start = Date.now();
  s.start('Loading workspace members…');
  let members: SlackMember[];
  try {
    members = await listWorkspaceMembers(token);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    s.stop(`Couldn't load members: ${msg}`, 1);
    setupLog.step('slack-id-lookup', 'failed', Date.now() - start, { ERROR: msg });
    return 'manual';
  }
  s.stop(
    `${members.length} members loaded. ${k.dim(`(${fmtDuration(Date.now() - start)})`)}`,
  );
  setupLog.step('slack-id-lookup', 'success', Date.now() - start, {
    MEMBER_COUNT: String(members.length),
  });

  const query = ensureAnswer(
    await p.text({
      message: "What's your name (or email) in this Slack?",
      placeholder: displayName || 'e.g. Ali, ali@qwibit.ai',
      defaultValue: displayName || '',
    }),
  ) as string;

  const ranked = members
    .map((u) => ({ u, score: scoreMember(u, query.trim()) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  if (ranked.length === 0) {
    p.log.warn(`No matches for "${query}".`);
    return 'manual';
  }

  const choice = ensureAnswer(
    await brightSelect<string>({
      message: 'Which one is you?',
      options: [
        ...ranked.map(({ u }) => ({
          value: u.id,
          label: u.real_name || u.profile?.display_name || u.name,
          hint: `${u.id}${u.profile?.email ? '  ·  ' + u.profile.email : ''}`,
        })),
        { value: '__manual__', label: 'None of these — let me paste it manually' },
        { value: '__back__', label: '← Back to channel selection' },
      ],
    }),
  ) as string;

  if (choice === '__manual__') return 'manual';
  if (choice === '__back__') return 'back';
  const picked = ranked.find((x) => x.u.id === choice);
  const label =
    picked?.u.real_name || picked?.u.profile?.display_name || picked?.u.name || choice;
  setupLog.userInput('slack_user_id_via_lookup', choice);
  return { id: choice, label };
}

interface OpenDmResult {
  ok: boolean;
  channelId?: string;
  error?: string;
}

async function tryOpenDm(token: string, userId: string): Promise<OpenDmResult> {
  try {
    const res = await fetch(`${SLACK_API}/conversations.open`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ users: userId }),
    });
    const data = (await res.json()) as {
      ok?: boolean;
      channel?: { id?: string };
      error?: string;
    };
    if (data.ok && data.channel?.id) {
      return { ok: true, channelId: data.channel.id };
    }
    return { ok: false, error: data.error ?? `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Open a DM channel with the operator. On `user_not_found`, branch into
 * the lookup-or-retype fallback instead of aborting setup. Other errors
 * (missing_scope, network, etc.) bail like before. Returns the eventual
 * member ID and DM channel ID — the member ID may differ from the one
 * the user originally pasted if they used the lookup branch.
 */
async function openDmChannel(
  token: string,
  initialUserId: string,
  displayName: string,
): Promise<
  { userId: string; dmChannelId: string } | typeof BACK_TO_CHANNEL_SELECTION
> {
  const MAX_ATTEMPTS = 3;
  let userId = initialUserId;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const s = p.spinner();
    const start = Date.now();
    s.start('Opening a DM channel…');
    const result = await tryOpenDm(token, userId);
    if (result.ok && result.channelId) {
      s.stop(`DM channel ready. ${k.dim(`(${fmtDuration(Date.now() - start)})`)}`);
      setupLog.step('slack-open-dm', 'success', Date.now() - start, {
        DM_CHANNEL_ID: result.channelId,
        ATTEMPTS: String(attempt + 1),
      });
      return { userId, dmChannelId: result.channelId };
    }
    const reason = result.error ?? 'unknown';
    s.stop(`Couldn't open a DM channel: ${reason}`, 1);
    setupLog.step('slack-open-dm', 'failed', Date.now() - start, {
      ERROR: reason,
      ATTEMPT: String(attempt + 1),
    });

    if (reason === 'missing_scope') {
      await fail(
        'slack-open-dm',
        "Your Slack app is missing the im:write scope.",
        'Go to OAuth & Permissions in your Slack app settings, add the im:write scope, reinstall the app, then retry setup.',
      );
    }
    if (reason !== 'user_not_found') {
      await fail(
        'slack-open-dm',
        "Couldn't open a DM channel with you.",
        `Slack said "${reason}". Check the member ID and app permissions, then retry.`,
      );
    }
    if (attempt === MAX_ATTEMPTS - 1) {
      await fail(
        'slack-open-dm',
        "Couldn't open a DM channel with you.",
        `Slack didn't recognize the member ID after ${MAX_ATTEMPTS} attempts. Check that you're copying it from the same workspace your bot is installed in, then retry setup.`,
      );
    }

    const next = ensureAnswer(
      await brightSelect<'lookup' | 'retype' | 'back'>({
        message: "Slack didn't recognize that ID. What now?",
        options: [
          { value: 'lookup', label: 'Look it up for me', hint: 'search by name or email' },
          { value: 'retype', label: 'Paste a different ID' },
          { value: 'back', label: '← Back to channel selection' },
        ],
        initialValue: 'lookup',
      }),
    );

    if (next === 'back') {
      setupLog.step('slack-open-dm', 'aborted', 0, { REASON: 'user_back_to_channels' });
      return BACK_TO_CHANNEL_SELECTION;
    }
    if (next === 'lookup') {
      const found = await lookupSlackUserId(token, displayName);
      if (found === 'back') {
        setupLog.step('slack-open-dm', 'aborted', 0, {
          REASON: 'user_back_to_channels',
        });
        return BACK_TO_CHANNEL_SELECTION;
      }
      if (found !== 'manual') {
        const confirmed = ensureAnswer(
          await p.confirm({
            message: `Wire this agent to ${found.label} (${found.id})? They'll get a welcome DM.`,
            initialValue: true,
          }),
        );
        if (confirmed) {
          userId = found.id;
          continue;
        }
        // not confirmed — fall through to manual paste so they can correct.
      }
      // 'manual' or rejected confirmation → fall through to retype.
    }
    userId = await collectSlackUserId();
  }
  // unreachable — fail() exits before we get here
  throw new Error('exhausted DM open attempts');
}

async function resolveAgentName(): Promise<string> {
  const preset = process.env.NANOCLAW_AGENT_NAME?.trim();
  if (preset) {
    setupLog.userInput('agent_name', preset);
    return preset;
  }
  const answer = ensureAnswer(
    await p.text({
      message: `What should your ${accentGreen('assistant')} be called?`,
      placeholder: DEFAULT_AGENT_NAME,
      defaultValue: DEFAULT_AGENT_NAME,
    }),
  );
  const value = (answer as string).trim() || DEFAULT_AGENT_NAME;
  setupLog.userInput('agent_name', value);
  return value;
}

function showPostInstallChecklist(info: WorkspaceInfo): void {
  note(
    wrapForGutter(
      [
        `Your agent is wired to Slack and a welcome DM is on its way.`,
        `To receive replies, Slack needs a public URL for delivering events:`,
        '',
        '  1. Expose NanoClaw\'s webhook server (port 3000) via ngrok,',
        '     Cloudflare Tunnel, or a reverse proxy on a VPS.',
        '',
        '  2. In your Slack app → Event Subscriptions:',
        '     • Toggle "Enable Events" on',
        `     • Request URL: https://<your-public-host>/webhook/slack`,
        '     • Subscribe to bot events: message.channels, message.groups,',
        '       message.im, app_mention',
        '     • Save Changes',
        '',
        '  3. In your Slack app → Interactivity & Shortcuts:',
        '     • Toggle "Interactivity" on',
        `     • Request URL: https://<your-public-host>/webhook/slack`,
        '     • Save Changes',
        '',
        '  4. Slack will prompt you to reinstall the app — do it to apply',
        '     the new settings',
      ].join('\n'),
      6,
    ),
    'Finish setting up Slack',
  );
}
