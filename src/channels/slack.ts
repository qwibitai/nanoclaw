/**
 * Slack channel adapter — FORK DEVIATION from upstream /add-slack.
 *
 * Upstream ships a single-workspace adapter (one SLACK_BOT_TOKEN +
 * SLACK_SIGNING_SECRET, channelType "slack"). Our fork needs multiple
 * concurrent Slack workspaces in one host process because we run a
 * primary Slack + the Illysium Slack side-by-side.
 *
 * Multi-workspace env-var convention:
 *   SLACK_BOT_TOKEN=xoxb-…                    → channelType "slack"
 *   SLACK_SIGNING_SECRET=…
 *   SLACK_BOT_TOKEN_<SUFFIX>=xoxb-…           → channelType "slack-<suffix>"
 *   SLACK_SIGNING_SECRET_<SUFFIX>=…
 *
 * Each workspace is a separate Slack app (created per-workspace at
 * api.slack.com/apps, "Not distributed"). Suffix is any [A-Za-z0-9]+ and
 * is lowercased for the channelType.
 *
 * This file is re-applied on top of the upstream /add-slack output so
 * `/add-slack` remains an idempotent install that preserves the
 * channels-via-skills model, and the deviation is a single clearly-
 * commented overlay. Revisit upstreaming after cutover — the only piece
 * of the NanoClaw core this requires is the optional `channelType`
 * override on createChatSdkBridge (already merged upstream-compatible).
 */
import { createSlackAdapter } from '@chat-adapter/slack';
import { WebClient } from '@slack/web-api';

import { readEnvFileMatching } from '../env.js';
import { log } from '../log.js';
import { markdownHeadingsToBold } from '../text-styles.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

export interface SlackWorkspace {
  channelType: string;
  botToken: string;
  signingSecret: string;
}

/**
 * Pure helper — parse workspace configs from an env key/value map.
 * Exported for testing.
 */
export function parseSlackWorkspaces(env: Record<string, string>): SlackWorkspace[] {
  const bySuffix = new Map<string, { botToken?: string; signingSecret?: string }>();

  for (const [key, value] of Object.entries(env)) {
    const m = key.match(/^SLACK_(BOT_TOKEN|SIGNING_SECRET)(?:_([A-Za-z0-9]+))?$/);
    if (!m) continue;
    const [, kind, rawSuffix] = m;
    const suffix = rawSuffix ? rawSuffix.toLowerCase() : '';
    const entry = bySuffix.get(suffix) ?? {};
    if (kind === 'BOT_TOKEN') entry.botToken = value;
    else entry.signingSecret = value;
    bySuffix.set(suffix, entry);
  }

  const workspaces: SlackWorkspace[] = [];
  for (const [suffix, pair] of bySuffix) {
    if (!pair.botToken) continue;
    if (!pair.signingSecret) {
      log.warn('Slack workspace missing signing secret, skipping', {
        suffix: suffix || '(primary)',
      });
      continue;
    }
    workspaces.push({
      channelType: suffix ? `slack-${suffix}` : 'slack',
      botToken: pair.botToken,
      signingSecret: pair.signingSecret,
    });
  }
  return workspaces;
}

/** Minimal interface for the Slack chat.postMessage client — narrow surface for testing. */
export interface SlackPostMessageClient {
  chat: {
    postMessage(args: { channel: string; text: string; thread_ts?: string }): Promise<{ ts?: string | null }>;
  };
}

/**
 * Strip the `slack:` scheme prefix from a NanoClaw platform_id, leaving the
 * raw Slack channel ID the Web API expects. Tolerates both prefixed
 * (`slack:C0AJA89MN2E`, the canonical messaging_groups.platform_id form) and
 * raw (`C0AJA89MN2E`, used in unit tests) inputs. The host's regular delivery
 * path normalizes via the chat-sdk bridge — these helpers are called from
 * orchestrator-dispatch directly and need to do their own normalization or
 * Slack returns `channel_not_found`.
 */
export function extractSlackChannelId(platformId: string): string {
  return platformId.startsWith('slack:') ? platformId.slice('slack:'.length) : platformId;
}

/**
 * Post a message to the top level of a Slack channel.
 * Exported for unit testing.
 */
export async function slackPostParent(
  client: SlackPostMessageClient,
  platformId: string,
  text: string,
): Promise<{ messageId: string }> {
  const channel = extractSlackChannelId(platformId);
  const response = await client.chat.postMessage({ channel, text });
  return { messageId: response.ts as string };
}

/**
 * Create a Slack thread by posting a reply to an existing parent message.
 * threadId IS the parent message's ts (Slack thread_ts semantic) — NOT reply.ts.
 * Exported for unit testing.
 */
export async function slackCreateThread(
  client: SlackPostMessageClient,
  platformId: string,
  parentMessageId: string,
  _title: string,
  firstMessage: string,
): Promise<{ threadId: string; messageId: string }> {
  const channel = extractSlackChannelId(platformId);
  const reply = await client.chat.postMessage({
    channel,
    thread_ts: parentMessageId,
    text: firstMessage,
  });
  return { threadId: parentMessageId, messageId: reply.ts as string };
}

const workspaces = parseSlackWorkspaces(readEnvFileMatching(/^SLACK_(BOT_TOKEN|SIGNING_SECRET)(_[A-Za-z0-9]+)?$/));

for (const ws of workspaces) {
  registerChannelAdapter(ws.channelType, {
    factory: () => {
      const slackAdapter = createSlackAdapter({
        botToken: ws.botToken,
        signingSecret: ws.signingSecret,
      });
      const client = new WebClient(ws.botToken);
      const bridge = createChatSdkBridge({
        adapter: slackAdapter,
        concurrency: 'concurrent',
        supportsThreads: true,
        channelType: ws.channelType,
        // ATX headings → bold so Block Kit table delivery stays on the
        // `markdown` path (table-block conversion only fires for markdown/ast
        // input). The adapter handles bold/italic/links/lists/tables natively.
        transformOutboundMarkdown: markdownHeadingsToBold,
      });
      bridge.postParent = (platformId, text) => slackPostParent(client, platformId, text);
      bridge.createThread = (platformId, parentMessageId, title, firstMessage) =>
        slackCreateThread(client, platformId, parentMessageId, title, firstMessage);
      return bridge;
    },
  });
}

if (workspaces.length > 1) {
  log.info('Multiple Slack workspaces registered', {
    channelTypes: workspaces.map((w) => w.channelType),
  });
}
