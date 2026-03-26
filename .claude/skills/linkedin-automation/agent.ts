/**
 * LinkedIn Automation — MCP Tool Definitions (Agent / Container Side)
 *
 * These tools run inside the container and communicate with the host via IPC.
 * The host-side implementation is in host.ts.
 *
 * Note: This file is compiled in the container, not on the host.
 * The @ts-ignore is needed because the SDK is only available in the container.
 */

// @ts-ignore - SDK available in container environment only
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

// IPC directories (inside container)
const IPC_DIR   = '/workspace/ipc';
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const RESULTS_DIR = path.join(IPC_DIR, 'li_results');

function writeIpcFile(data: object): string {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(TASKS_DIR, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
  return filename;
}

async function waitForResult(requestId: string, maxWait = 180000): Promise<{ success: boolean; message: string; data?: unknown }> {
  const resultFile = path.join(RESULTS_DIR, `${requestId}.json`);
  const pollInterval = 1000;
  let elapsed = 0;
  while (elapsed < maxWait) {
    if (fs.existsSync(resultFile)) {
      try {
        const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
        fs.unlinkSync(resultFile);
        return result;
      } catch {
        return { success: false, message: 'Failed to read result file' };
      }
    }
    await new Promise(r => setTimeout(r, pollInterval));
    elapsed += pollInterval;
  }
  return { success: false, message: 'Request timed out (3 min)' };
}

export interface SkillToolsContext {
  groupFolder: string;
  isMain: boolean;
}

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function dispatch(type: string, requestId: string, payload: object, groupFolder: string) {
  writeIpcFile({ type, requestId, groupFolder, timestamp: new Date().toISOString(), ...payload });
  return waitForResult(requestId);
}

function toolResult(result: { success: boolean; message: string; data?: unknown }) {
  return {
    content: [{ type: 'text', text: result.data
      ? `${result.message}\n\n${JSON.stringify(result.data, null, 2)}`
      : result.message
    }],
    isError: !result.success,
  };
}

// ─── Tool Definitions ─────────────────────────────────────────────────────────

export function createLinkedInTools(ctx: SkillToolsContext) {
  const { groupFolder, isMain } = ctx;

  const mainOnly = () => ({
    content: [{ type: 'text', text: 'LinkedIn tools are only available in the main group.' }],
    isError: true,
  });

  return [

    // ── Visit Profile ────────────────────────────────────────────────────────
    tool('li_visit_profile',
      'Visit a LinkedIn profile page. Registers as a profile view. Updates lead status to Visited in Notion.',
      { profile_url: z.string().describe('LinkedIn profile URL (e.g. https://linkedin.com/in/johndoe)') },
      async ({ profile_url }: { profile_url: string }) => {
        if (!isMain) return mainOnly();
        const id = makeId('li-visit');
        return toolResult(await dispatch('li_visit_profile', id, { profileUrl: profile_url }, groupFolder));
      }
    ),

    // ── Send Connection ──────────────────────────────────────────────────────
    tool('li_connect',
      'Send a LinkedIn connection request. Optionally include a personalized note (max 300 chars). Respects daily limit.',
      {
        profile_url: z.string().describe('LinkedIn profile URL'),
        note: z.string().optional().describe('Optional personalized note to include with the request (max 300 chars)'),
      },
      async ({ profile_url, note }: { profile_url: string; note?: string }) => {
        if (!isMain) return mainOnly();
        const id = makeId('li-connect');
        return toolResult(await dispatch('li_connect', id, { profileUrl: profile_url, note }, groupFolder));
      }
    ),

    // ── Withdraw Request ─────────────────────────────────────────────────────
    tool('li_withdraw_request',
      'Withdraw a pending LinkedIn connection request.',
      { profile_url: z.string().describe('LinkedIn profile URL of the pending request to withdraw') },
      async ({ profile_url }: { profile_url: string }) => {
        if (!isMain) return mainOnly();
        const id = makeId('li-withdraw');
        return toolResult(await dispatch('li_withdraw_request', id, { profileUrl: profile_url }, groupFolder));
      }
    ),

    // ── Send Message ─────────────────────────────────────────────────────────
    tool('li_message',
      'Send a direct message to a 1st-degree LinkedIn connection. Respects daily message limit.',
      {
        profile_url: z.string().describe('LinkedIn profile URL'),
        message: z.string().describe('The message to send'),
      },
      async ({ profile_url, message }: { profile_url: string; message: string }) => {
        if (!isMain) return mainOnly();
        const id = makeId('li-msg');
        return toolResult(await dispatch('li_message', id, { profileUrl: profile_url, message }, groupFolder));
      }
    ),

    // ── Follow ───────────────────────────────────────────────────────────────
    tool('li_follow',
      'Follow a LinkedIn person or company page.',
      { profile_url: z.string().describe('LinkedIn profile or company page URL') },
      async ({ profile_url }: { profile_url: string }) => {
        if (!isMain) return mainOnly();
        const id = makeId('li-follow');
        return toolResult(await dispatch('li_follow', id, { profileUrl: profile_url }, groupFolder));
      }
    ),

    // ── Unfollow ─────────────────────────────────────────────────────────────
    tool('li_unfollow',
      'Unfollow a LinkedIn person or company page.',
      { profile_url: z.string().describe('LinkedIn profile or company page URL') },
      async ({ profile_url }: { profile_url: string }) => {
        if (!isMain) return mainOnly();
        const id = makeId('li-unfollow');
        return toolResult(await dispatch('li_unfollow', id, { profileUrl: profile_url }, groupFolder));
      }
    ),

    // ── Like Post ────────────────────────────────────────────────────────────
    tool('li_like_post',
      'Like a LinkedIn post.',
      { post_url: z.string().describe('LinkedIn post URL') },
      async ({ post_url }: { post_url: string }) => {
        if (!isMain) return mainOnly();
        const id = makeId('li-like');
        return toolResult(await dispatch('li_like_post', id, { postUrl: post_url }, groupFolder));
      }
    ),

    // ── React to Post ────────────────────────────────────────────────────────
    tool('li_react_post',
      'React to a LinkedIn post with a specific reaction: like, celebrate, support, funny, love, insightful, or curious.',
      {
        post_url:  z.string().describe('LinkedIn post URL'),
        reaction:  z.enum(['like','celebrate','support','funny','love','insightful','curious']).describe('Reaction type'),
      },
      async ({ post_url, reaction }: { post_url: string; reaction: string }) => {
        if (!isMain) return mainOnly();
        const id = makeId('li-react');
        return toolResult(await dispatch('li_react_post', id, { postUrl: post_url, reaction }, groupFolder));
      }
    ),

    // ── Comment on Post ──────────────────────────────────────────────────────
    tool('li_comment_post',
      'Comment on a LinkedIn post.',
      {
        post_url: z.string().describe('LinkedIn post URL'),
        comment:  z.string().describe('The comment text to post'),
      },
      async ({ post_url, comment }: { post_url: string; comment: string }) => {
        if (!isMain) return mainOnly();
        const id = makeId('li-comment');
        return toolResult(await dispatch('li_comment_post', id, { postUrl: post_url, comment }, groupFolder));
      }
    ),

    // ── Share / Repost ───────────────────────────────────────────────────────
    tool('li_share_post',
      'Share or repost a LinkedIn post, optionally with your own commentary.',
      {
        post_url:    z.string().describe('LinkedIn post URL'),
        commentary:  z.string().optional().describe('Optional commentary to add when sharing'),
      },
      async ({ post_url, commentary }: { post_url: string; commentary?: string }) => {
        if (!isMain) return mainOnly();
        const id = makeId('li-share');
        return toolResult(await dispatch('li_share_post', id, { postUrl: post_url, commentary }, groupFolder));
      }
    ),

    // ── Endorse Skill ────────────────────────────────────────────────────────
    tool('li_endorse_skill',
      "Endorse a specific skill on someone's LinkedIn profile.",
      {
        profile_url: z.string().describe('LinkedIn profile URL'),
        skill:       z.string().describe('The skill name to endorse (must match exactly)'),
      },
      async ({ profile_url, skill }: { profile_url: string; skill: string }) => {
        if (!isMain) return mainOnly();
        const id = makeId('li-endorse');
        return toolResult(await dispatch('li_endorse_skill', id, { profileUrl: profile_url, skill }, groupFolder));
      }
    ),

    // ── Scrape Search ────────────────────────────────────────────────────────
    tool('li_scrape_search',
      'Search LinkedIn for people matching a query and save them as leads to Notion. Returns count of leads saved. Use connections_only: true to restrict results to your 1st-degree connections only.',
      {
        query:            z.string().describe('Search query (e.g. "Head of Growth SaaS London")'),
        max_leads:        z.number().optional().describe('Max number of leads to scrape (default: 25, max: 100)'),
        campaign:         z.string().optional().describe('Campaign name to tag these leads with in Notion'),
        connections_only: z.boolean().optional().describe('If true, restrict results to 1st-degree connections only (default: false)'),
      },
      async ({ query, max_leads, campaign, connections_only }: { query: string; max_leads?: number; campaign?: string; connections_only?: boolean }) => {
        if (!isMain) return mainOnly();
        const id = makeId('li-search');
        return toolResult(await dispatch('li_scrape_search', id, { query, maxLeads: max_leads, campaign, connectionsOnly: connections_only }, groupFolder));
      }
    ),

    // ── Scrape Profile ───────────────────────────────────────────────────────
    tool('li_scrape_profile',
      'Scrape a single LinkedIn profile and save all data to Notion.',
      {
        profile_url: z.string().describe('LinkedIn profile URL'),
        campaign:    z.string().optional().describe('Campaign tag for this lead'),
        source:      z.string().optional().describe('Where this lead came from (e.g. Search, Event, Referral)'),
      },
      async ({ profile_url, campaign, source }: { profile_url: string; campaign?: string; source?: string }) => {
        if (!isMain) return mainOnly();
        const id = makeId('li-scrape-profile');
        return toolResult(await dispatch('li_scrape_profile', id, { profileUrl: profile_url, campaign, source }, groupFolder));
      }
    ),

    // ── Scrape Post Engagers ─────────────────────────────────────────────────
    tool('li_scrape_post_engagers',
      'Extract people who reacted to or commented on a LinkedIn post and save them as leads to Notion.',
      {
        post_url:   z.string().describe('LinkedIn post URL'),
        max_leads:  z.number().optional().describe('Max leads to scrape (default: 50)'),
        campaign:   z.string().optional().describe('Campaign tag'),
        type:       z.enum(['reactions','comments']).optional().describe('Scrape reactions (default) or comments'),
      },
      async ({ post_url, max_leads, campaign, type }: { post_url: string; max_leads?: number; campaign?: string; type?: 'reactions' | 'comments' }) => {
        if (!isMain) return mainOnly();
        const id = makeId('li-post-engagers');
        return toolResult(await dispatch('li_scrape_post_engagers', id, { postUrl: post_url, maxLeads: max_leads, campaign, type }, groupFolder));
      }
    ),

    // ── Run Campaign ─────────────────────────────────────────────────────────
    tool('li_run_campaign',
      'Run an automated LinkedIn outreach campaign. Processes leads from Notion and runs visit → connect → message sequence.',
      {
        steps: z.array(z.enum(['visit','connect','message'])).describe('Steps to run in order'),
        connect_note:  z.string().optional().describe('Connection request note. Use {name} for first name.'),
        message_text:  z.string().optional().describe('Message to send. Use {name} for first name.'),
        campaign:      z.string().optional().describe('Only process leads in this campaign'),
        from_status:   z.enum(['New','Visited','Requested','Connected','Messaged','Replied','Archived']).optional().describe('Process leads with this status (default: New)'),
        max_leads:     z.number().optional().describe('Max leads to process this run (default: 10)'),
      },
      async (args: {
        steps: string[];
        connect_note?: string;
        message_text?: string;
        campaign?: string;
        from_status?: string;
        max_leads?: number;
      }) => {
        if (!isMain) return mainOnly();
        const id = makeId('li-campaign');
        return toolResult(await dispatch('li_run_campaign', id, {
          steps:       args.steps,
          connectNote: args.connect_note,
          messageText: args.message_text,
          campaign:    args.campaign,
          fromStatus:  args.from_status,
          maxLeads:    args.max_leads,
        }, groupFolder));
      }
    ),

    // ── Bulk Message ─────────────────────────────────────────────────────────
    tool('li_bulk_message',
      'Send a personalized message to all Connected leads in Notion. Use {name} for first name personalization.',
      {
        message_text:  z.string().describe('Message template. Use {name} for recipient first name.'),
        campaign:      z.string().optional().describe('Only message leads in this campaign'),
        max_messages:  z.number().optional().describe('Max messages to send this run (default: 20)'),
      },
      async ({ message_text, campaign, max_messages }: { message_text: string; campaign?: string; max_messages?: number }) => {
        if (!isMain) return mainOnly();
        const id = makeId('li-bulk-msg');
        return toolResult(await dispatch('li_bulk_message', id, { messageText: message_text, campaign, maxMessages: max_messages }, groupFolder));
      }
    ),

    // ── Campaign Stats ───────────────────────────────────────────────────────
    tool('li_get_campaign_stats',
      'Get LinkedIn outreach stats from Notion — counts of leads by status.',
      {
        campaign: z.string().optional().describe('Filter stats to a specific campaign'),
      },
      async ({ campaign }: { campaign?: string }) => {
        if (!isMain) return mainOnly();
        const id = makeId('li-stats');
        return toolResult(await dispatch('li_get_campaign_stats', id, { campaign }, groupFolder));
      }
    ),

  ];
}
