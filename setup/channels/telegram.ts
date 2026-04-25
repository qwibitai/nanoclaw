/**
 * Telegram channel flow for setup:auto.
 *
 * `runTelegramChannel(displayName)` owns the full branch from the
 * BotFather instructions through the welcome DM:
 *
 *   1. BotFather instructions (clack note)
 *   2. Paste the bot token (clack password) — format-validated
 *   3. getMe via the Bot API to resolve the bot's username
 *   4. Confirm + deep-link into the bot's Telegram chat (tg://resolve)
 *   5. Install the adapter (setup/add-telegram.sh, non-interactive)
 *   6. Run the pair-telegram step, rendering code events as clack notes
 *   7. Ask for the messaging-agent name (defaulting to "Nano")
 *   8. Wire the agent via scripts/init-first-agent.ts
 *
 * All output obeys the three-level contract: clack UI for the user,
 * structured entries in logs/setup.log, full raw output in per-step files
 * under logs/setup-steps/. See docs/setup-flow.md.
 */
import * as p from '@clack/prompts';
import k from 'kleur';

import * as setupLog from '../logs.js';
import { confirmThenOpen } from '../lib/browser.js';
import { askOperatorRole } from '../lib/role-prompt.js';
import {
  type Block,
  type StepResult,
  dumpTranscriptOnFailure,
  ensureAnswer,
  fail,
  runQuietChild,
  spawnStep,
  writeStepEntry,
} from '../lib/runner.js';
import { brandBold } from '../lib/theme.js';

const DEFAULT_AGENT_NAME = 'Nano';

export async function runTelegramChannel(displayName: string): Promise<void> {
  const token = await collectTelegramToken();
  const botUsername = await validateTelegramToken(token);

  // Deep-link the user into the bot's chat so they're on the right screen
  // by the time pair-telegram prints the code. https://t.me/<bot> works
  // everywhere: browsers show an "Open in Telegram" button when the app is
  // installed, or the bot's web profile if not. tg://resolve?domain= is
  // more direct but silently fails when the scheme isn't registered.
  const botUrl = `https://t.me/${botUsername}`;
  p.note(
    [
      `Opening @${botUsername} in Telegram so it's ready when the pairing code shows up.`,
      '',
      k.dim(botUrl),
    ].join('\n'),
    'Open Telegram',
  );
  await confirmThenOpen(botUrl, 'Press Enter to open Telegram');

  const install = await runQuietChild(
    'telegram-install',
    'bash',
    ['setup/add-telegram.sh'],
    {
      running: `Connecting Telegram to @${botUsername}…`,
      done: 'Telegram connected.',
    },
    {
      env: { TELEGRAM_BOT_TOKEN: token },
      extraFields: { BOT_USERNAME: botUsername },
    },
  );
  if (!install.ok) {
    await fail(
      'telegram-install',
      "Couldn't connect Telegram.",
      'See logs/setup-steps/ for details, then retry setup.',
    );
  }

  const pair = await runPairTelegram();
  if (!pair.ok) {
    await fail(
      'pair-telegram',
      "Couldn't pair with Telegram.",
      'Re-run setup to try again.',
    );
  }

  const platformId = pair.terminal?.fields.PLATFORM_ID;
  const pairedUserId = pair.terminal?.fields.PAIRED_USER_ID;
  if (!platformId || !pairedUserId) {
    await fail(
      'pair-telegram',
      'Pairing completed but came back incomplete.',
      'Re-run setup to try again.',
    );
  }

  const role = await askOperatorRole('Telegram');
  setupLog.userInput('telegram_role', role);

  const agentName = await resolveAgentName();

  const init = await runQuietChild(
    'init-first-agent',
    'pnpm',
    [
      'exec', 'tsx', 'scripts/init-first-agent.ts',
      '--channel', 'telegram',
      '--user-id', pairedUserId,
      '--platform-id', platformId,
      '--display-name', displayName,
      '--agent-name', agentName,
      '--role', role,
    ],
    {
      running: `Connecting ${agentName} to your Telegram chat…`,
      done: `${agentName} is ready. Check Telegram for a welcome message.`,
    },
    {
      extraFields: { CHANNEL: 'telegram', AGENT_NAME: agentName, PLATFORM_ID: platformId },
    },
  );
  if (!init.ok) {
    await fail(
      'init-first-agent',
      `Couldn't finish connecting ${agentName}.`,
      'You can retry later with `/manage-channels`.',
    );
  }
}

async function collectTelegramToken(): Promise<string> {
  p.note(
    [
      "Your assistant talks to you through a Telegram bot you create.",
      "Here's how:",
      '',
      '  1. Open Telegram and message @BotFather',
      '  2. Send /newbot and follow the prompts',
      '  3. Copy the token it gives you (it looks like <digits>:<chars>)',
      '',
      k.dim('Planning to add your assistant to group chats? In @BotFather:'),
      k.dim('    /mybots → your bot → Bot Settings → Group Privacy → OFF'),
    ].join('\n'),
    'Set up your Telegram bot',
  );

  const answer = ensureAnswer(
    await p.password({
      message: 'Paste your bot token',
      validate: (v) => {
        if (!v || !v.trim()) return "Token is required";
        if (!/^[0-9]+:[A-Za-z0-9_-]{35,}$/.test(v.trim())) {
          return "That doesn't look right. It should be <digits>:<chars>";
        }
        return undefined;
      },
    }),
  );
  const token = (answer as string).trim();
  setupLog.userInput(
    'telegram_token',
    `${token.slice(0, 12)}…${token.slice(-4)}`,
  );
  return token;
}

async function validateTelegramToken(token: string): Promise<string> {
  const s = p.spinner();
  const start = Date.now();
  s.start('Checking your bot token…');
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = (await res.json()) as {
      ok?: boolean;
      result?: { username?: string; id?: number };
      description?: string;
    };
    const elapsedS = Math.round((Date.now() - start) / 1000);
    if (data.ok && data.result?.username) {
      const username = data.result.username;
      s.stop(`Found your bot: @${username}. ${k.dim(`(${elapsedS}s)`)}`);
      setupLog.step('telegram-validate', 'success', Date.now() - start, {
        BOT_USERNAME: username,
        BOT_ID: data.result.id ?? '',
      });
      return username;
    }
    const reason = data.description ?? 'token rejected by Telegram';
    s.stop(`Telegram didn't accept that token: ${reason}`, 1);
    setupLog.step('telegram-validate', 'failed', Date.now() - start, {
      ERROR: reason,
    });
    await fail(
      'telegram-validate',
      "Telegram didn't accept that token.",
      'Copy the token again from @BotFather and try setup once more.',
    );
  } catch (err) {
    const elapsedS = Math.round((Date.now() - start) / 1000);
    s.stop(`Couldn't reach Telegram. ${k.dim(`(${elapsedS}s)`)}`, 1);
    const message = err instanceof Error ? err.message : String(err);
    setupLog.step('telegram-validate', 'failed', Date.now() - start, {
      ERROR: message,
    });
    await fail(
      'telegram-validate',
      "Couldn't reach Telegram.",
      'Check your internet connection and retry setup.',
    );
  }
}

async function runPairTelegram(): Promise<
  StepResult & { rawLog: string; durationMs: number }
> {
  const rawLog = setupLog.stepRawLog('pair-telegram');
  const start = Date.now();
  const s = p.spinner();
  s.start('Generating a secret code for your bot…');
  let spinnerActive = true;

  const stopSpinner = (msg: string, code?: number) => {
    if (spinnerActive) {
      s.stop(msg, code);
      spinnerActive = false;
    }
  };

  const result = await spawnStep(
    'pair-telegram',
    ['--intent', 'main'],
    (block: Block) => {
      if (block.type === 'PAIR_TELEGRAM_CODE') {
        const reason = block.fields.REASON ?? 'initial';
        if (reason === 'initial') {
          stopSpinner('Your secret code is ready.');
        } else {
          stopSpinner("Old code expired. Here's a fresh one.");
        }
        p.note(formatCodeCard(block.fields.CODE ?? '????'), 'Secret code');
        s.start('Waiting for you to send the code from Telegram…');
        spinnerActive = true;
      } else if (block.type === 'PAIR_TELEGRAM_ATTEMPT') {
        stopSpinner(`Got "${block.fields.CANDIDATE ?? '?'}", not a match.`);
        s.start('Waiting for the correct code…');
        spinnerActive = true;
      } else if (block.type === 'PAIR_TELEGRAM') {
        if (block.fields.STATUS === 'success') {
          stopSpinner('Telegram paired.');
        } else {
          stopSpinner(`Pairing failed: ${block.fields.ERROR ?? 'unknown'}`, 1);
        }
      }
    },
    rawLog,
  );
  const durationMs = Date.now() - start;

  // Safety net: if the child died without emitting a terminal block, make
  // sure we don't leave the spinner running.
  if (spinnerActive) {
    stopSpinner(
      result.ok ? 'Done.' : 'Pairing ended unexpectedly.',
      result.ok ? 0 : 1,
    );
    if (!result.ok) dumpTranscriptOnFailure(result.transcript);
  }

  writeStepEntry('pair-telegram', result, durationMs, rawLog);
  return { ...result, rawLog, durationMs };
}

function formatCodeCard(code: string): string {
  const spaced = code.split('').join('   ');
  return [
    '',
    `   ${brandBold(spaced)}`,
    '',
    k.dim('   Send this code to your bot from Telegram.'),
  ].join('\n');
}

async function resolveAgentName(): Promise<string> {
  const preset = process.env.NANOCLAW_AGENT_NAME?.trim();
  if (preset) {
    setupLog.userInput('agent_name', preset);
    return preset;
  }
  const answer = ensureAnswer(
    await p.text({
      message: 'What should your assistant be called?',
      placeholder: DEFAULT_AGENT_NAME,
      defaultValue: DEFAULT_AGENT_NAME,
    }),
  );
  const value = (answer as string).trim() || DEFAULT_AGENT_NAME;
  setupLog.userInput('agent_name', value);
  return value;
}
