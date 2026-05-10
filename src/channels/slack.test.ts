import { describe, expect, it, vi } from 'vitest';

import { parseSlackWorkspaces, slackPostParent, slackCreateThread, type SlackPostMessageClient } from './slack.js';

describe('parseSlackWorkspaces', () => {
  it('returns an empty list when no credentials present', () => {
    expect(parseSlackWorkspaces({})).toEqual([]);
  });

  it('registers the primary workspace as channelType "slack"', () => {
    const ws = parseSlackWorkspaces({
      SLACK_BOT_TOKEN: 'xoxb-primary',
      SLACK_SIGNING_SECRET: 'sig-primary',
    });
    expect(ws).toEqual([{ channelType: 'slack', botToken: 'xoxb-primary', signingSecret: 'sig-primary' }]);
  });

  it('registers suffixed workspaces as channelType "slack-<suffix>" (lowercased)', () => {
    const ws = parseSlackWorkspaces({
      SLACK_BOT_TOKEN_ILLYSIUM: 'xoxb-ill',
      SLACK_SIGNING_SECRET_ILLYSIUM: 'sig-ill',
      SLACK_BOT_TOKEN_NEWJOB: 'xoxb-new',
      SLACK_SIGNING_SECRET_NEWJOB: 'sig-new',
    });
    expect(ws.map((w) => w.channelType).sort()).toEqual(['slack-illysium', 'slack-newjob']);
  });

  it('registers primary and suffixed workspaces together', () => {
    const ws = parseSlackWorkspaces({
      SLACK_BOT_TOKEN: 'xoxb-p',
      SLACK_SIGNING_SECRET: 'sig-p',
      SLACK_BOT_TOKEN_SECOND: 'xoxb-s',
      SLACK_SIGNING_SECRET_SECOND: 'sig-s',
    });
    expect(ws.map((w) => w.channelType).sort()).toEqual(['slack', 'slack-second']);
  });

  it('skips workspaces missing a signing secret', () => {
    const ws = parseSlackWorkspaces({
      SLACK_BOT_TOKEN: 'xoxb-p',
      SLACK_SIGNING_SECRET: 'sig-p',
      SLACK_BOT_TOKEN_ORPHAN: 'xoxb-orphan',
    });
    expect(ws).toEqual([{ channelType: 'slack', botToken: 'xoxb-p', signingSecret: 'sig-p' }]);
  });

  it('skips workspaces missing a bot token', () => {
    const ws = parseSlackWorkspaces({
      SLACK_SIGNING_SECRET_ORPHAN: 'sig-orphan',
    });
    expect(ws).toEqual([]);
  });
});

describe('slackPostParent', () => {
  it('test_post_parent_returns_ts: returns {messageId} from response.ts', async () => {
    const mockClient: SlackPostMessageClient = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ts: 'parent-1234.5678', ok: true }),
      },
    };
    const result = await slackPostParent(mockClient, 'C0', 'launched task');
    expect(result).toEqual({ messageId: 'parent-1234.5678' });
    expect(mockClient.chat.postMessage).toHaveBeenCalledWith({ channel: 'C0', text: 'launched task' });
  });
});

describe('slackCreateThread', () => {
  it('test_create_thread_returns_parent_as_thread_id: threadId === parentMessageId (not reply.ts)', async () => {
    const mockClient: SlackPostMessageClient = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ts: 'reply-9999.0000', ok: true }),
      },
    };
    const result = await slackCreateThread(mockClient, 'C0', 'parent-1234.5678', 'Task X', 'first message');
    expect(result).toEqual({ threadId: 'parent-1234.5678', messageId: 'reply-9999.0000' });
  });

  it('test_create_thread_passes_thread_ts_correctly: calls postMessage with thread_ts = parentMessageId', async () => {
    const postMessage = vi.fn().mockResolvedValue({ ts: 'reply-ts', ok: true });
    const mockClient: SlackPostMessageClient = { chat: { postMessage } };
    await slackCreateThread(mockClient, 'C0', 'parent-X', 'Task', 'msg');
    expect(postMessage).toHaveBeenCalledWith({
      channel: 'C0',
      thread_ts: 'parent-X',
      text: 'msg',
    });
  });
});
