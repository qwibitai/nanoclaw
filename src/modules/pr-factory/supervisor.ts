/**
 * PR Factory Supervisor — a dedicated agent group that reviews and
 * improves PR worker output based on human feedback.
 *
 * The supervisor gets its own Discord bot identity (bot_id-keyed)
 * and can:
 *   - Receive cross-thread @Supervisor mentions routed to its admin channel
 *   - Clear worker sessions and retrigger triage
 *   - Edit container skills and commit changes
 *   - Post feedback back to PR threads via send_message
 *
 * Setup: requires DISCORD_SUPERVISOR_BOT_TOKEN in .env and a Discord
 * channel where the supervisor bot is invited. The supervisor group is
 * created once at startup if it doesn't already exist.
 */
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../../db/messaging-groups.js';
import { initGroupFilesystem } from '../../group-init.js';
import { log } from '../../log.js';
import { getBotId } from './discord-bots.js';

const SUPERVISOR_FOLDER = 'pr-factory-supervisor';

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const SUPERVISOR_INSTRUCTIONS = `# PR Factory Supervisor

You are the PR Factory Supervisor. You improve the PR review workers based on human feedback.

## Critical Rules

1. **Always reply to the right place.** Messages from PR threads contain \`[From thread: dc:XXXXX — ...]\`. Extract the thread JID and use \`mcp__nanoclaw__send_message\` with that JID. Messages in your own channel — just respond normally.
2. **Never output bare text when responding to a PR thread.** Your text output goes to your admin channel. Use \`send_message\` to reach PR threads.
3. **Don't edit skills without approval.** Propose diffs first. Once approved, edit the skill AND clear worker session + retrigger in one step. Never edit without rerunning.

## Two Workflows

### Workflow A: Quick Fix (in PR thread)

Human tags you in a PR thread and approves a change → you fix it and rerun.

1. Read feedback, investigate session logs
2. Propose the change (show diff). If human approves:
3. Edit the skill file
4. Clear worker session + retrigger — **always, no separate instruction needed**
5. Tell the human: what you changed, worker is re-running

Use this when the feedback is clear and the human approves.

### Workflow B: Batch Review (in supervisor channel)

Human tags you in multiple PR threads with feedback → later comes to your channel to review everything.

1. **Collect phase**: For each @Supervisor in a PR thread:
   - Acknowledge in the thread ("Noted, saved to feedback log")
   - Append to \`/workspace/group/feedback.md\`:
     \`\`\`
     ## PR #N (dc:CHANNEL_ID)
     **Feedback:** <what the human said>
     **Worker output:** <summary of what worker did>
     **Suggested fix:** <your analysis>
     \`\`\`

2. **Review phase**: Human comes to supervisor channel and asks to see feedback:
   - Show all collected feedback from \`/workspace/group/feedback.md\`
   - Propose skill diffs (show the before/after, don't apply yet)
   - Iterate based on human input

3. **Implement phase**: Human approves (says "implement", "do it", "yes", "approved", etc.):
   - Apply the skill edits
   - **Immediately** clear worker sessions and retrigger for ALL affected PRs — do not wait for a separate "rerun" instruction
   - Commit to git: \`cd /workspace/extra/project && git add container/skills/ && git commit -m "..."\`
   - Report: what you changed, which PRs are re-running

## Where Things Are

The NanoClaw project is mounted read-write at \`/workspace/extra/project/\`.

| What | Where |
|------|-------|
| Container skills (editable) | \`/workspace/extra/project/container/skills/\` |
| Session logs | \`/workspace/extra/project/data/sessions/{folder}/.claude/projects/-workspace-group/*.jsonl\` |
| PR groups | \`/workspace/extra/project/groups/\` (folders starting with \`pr-\`) |
| Your feedback log | \`/workspace/group/feedback.md\` |

## How to Investigate a PR

Extract PR number from thread name or message. Folder is \`pr-qwibitai-nanoclaw-{N}\`.

\`\`\`bash
# Find session log
ls /workspace/extra/project/data/sessions/pr-qwibitai-nanoclaw-{N}/.claude/projects/-workspace-group/*.jsonl

# Extract what the agent posted and what tools it used
cat <session.jsonl> | python3 -c "
import sys, json
for line in sys.stdin:
    obj = json.loads(line)
    if obj.get('type') == 'assistant':
        for c in (obj.get('message',{}).get('content') or []):
            if isinstance(c, dict) and c.get('type') == 'tool_use':
                if c.get('name') == 'mcp__nanoclaw__send_message':
                    print('SENT:', json.dumps(c['input'])[:500])
                else:
                    print('TOOL:', c.get('name'), json.dumps(c.get('input',{}))[:150])
"
\`\`\`

## How to Identify the PR You're Working On

Messages from PR threads include a context tag:
\`\`\`
[PR_CONTEXT: thread=dc:CHANNEL_ID folder=pr-qwibitai-nanoclaw-{N}]
\`\`\`

**Always use these values** for clear_session (folder) and retrigger (thread JID). Never guess or hardcode PR numbers.

## How to Clear Session and Retrigger

After editing a skill, **always** clear the worker session and retrigger. Use the
\`mcp__nanoclaw__clear_session\` and \`mcp__nanoclaw__retrigger\` tools:

\`\`\`
clear_session(folder="FOLDER_FROM_PR_CONTEXT")
retrigger(folder="FOLDER_FROM_PR_CONTEXT")
\`\`\`

For batch operations, call both tools for each affected PR.

## How to List PR Threads

\`\`\`bash
# All PR group folders
ls /workspace/extra/project/groups/ | grep '^pr-'
\`\`\`

## How to Commit Skill Changes

\`\`\`bash
cd /workspace/extra/project
git add container/skills/
git commit -m "skill: <describe the change>"
\`\`\`

## Principles

- **Smallest fix first** — one line change > rewrite
- **Patterns over one-offs** — fix the skill, not the individual PR
- **Evidence first** — show session data before proposing a fix
- **Human approves** — propose diffs, don't apply until told to
- **Always respond where the human is** — PR thread → send_message to thread; supervisor channel → normal response`;

/**
 * Ensure the supervisor agent group exists. Creates it on first run
 * with its CLAUDE.local.md instructions. Idempotent — skips if already present.
 *
 * Returns the supervisor's agent group ID, or null if creation is skipped
 * (e.g. no supervisor channel configured).
 */
export function ensureSupervisorGroup(supervisorChannelPlatformId: string): string | null {
  const existing = getAgentGroupByFolder(SUPERVISOR_FOLDER);
  if (existing) {
    log.debug('Supervisor agent group already exists', { id: existing.id });
    return existing.id;
  }

  const now = new Date().toISOString();
  const agentGroupId = generateId('ag-supervisor');

  const agentGroup = {
    id: agentGroupId,
    name: 'PR Factory Supervisor',
    folder: SUPERVISOR_FOLDER,
    agent_provider: null,
    created_at: now,
  };
  createAgentGroup(agentGroup);
  initGroupFilesystem(agentGroup, { instructions: SUPERVISOR_INSTRUCTIONS });

  // Create messaging group for the supervisor's Discord channel
  const mgId = generateId('mg-supervisor');
  createMessagingGroup({
    id: mgId,
    channel_type: 'discord',
    platform_id: supervisorChannelPlatformId,
    bot_id: getBotId('supervisor') ?? null,
    name: 'PR Factory Supervisor',
    is_group: 1,
    unknown_sender_policy: 'public' as const,
    created_at: now,
  });

  // Wire agent to messaging group — mention-only so supervisor ignores bot chatter;
  // accumulate so it has full thread context when a human @mentions it.
  const mgaId = generateId('mga-supervisor');
  createMessagingGroupAgent({
    id: mgaId,
    messaging_group_id: mgId,
    agent_group_id: agentGroupId,
    engage_mode: 'mention',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'accumulate',
    session_mode: 'shared',
    priority: 0,
    created_at: now,
  });

  log.info('Supervisor agent group created', { agentGroupId, folder: SUPERVISOR_FOLDER });
  return agentGroupId;
}

export { SUPERVISOR_FOLDER };
