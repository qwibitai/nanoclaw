import {
  createWorkItem,
  getAllGroupsForJid,
  isGroupPaused,
  markWorkItemDelivered,
  markWorkItemFailed,
} from '../db.js';
import { logger } from '../logger.js';
import { findChannelForAgent, formatOutbound } from '../router.js';
import { getAgentType } from '../runtimes/index.js';
import type { Channel, RegisteredGroup } from '../types.js';
import type { AgentExecutionService } from './agent-execution-service.js';
import type { GroupQueue } from '../group-queue.js';

const PLANNER_ORDER = ['claude-code', 'codex'] as const;
const WORKER_ORDER = ['copilot', 'gemini'] as const;
const COMPLEX_SUPPORT_RE =
  /(분석|설계|아키텍처|구조|리팩터|버그|구현|코드|debug|design|architecture|refactor|implement|investigate|research|plan)/i;
const AGENT_UNAVAILABLE_RE =
  /(not logged in|please run \/login|authentication_failed|quota|rate limit|usage limit|credit balance|conversation limit|session limit|reached (?:your|the) .* limit|try again .* after)/i;
const CLAUDE_PLANNER_TIMEOUT_MS = 120_000;
const CODEX_PLANNER_TIMEOUT_MS = 120_000;
const WORKER_TIMEOUT_MS = 120_000;

interface ConversationEntry {
  agent: string;
  text: string;
}

interface WorkerFinding {
  agentType: string;
  text: string;
}

type WorkerTaskMap = Partial<Record<'copilot' | 'gemini', string[]>>;

export interface PairedRoomServiceDeps {
  channels: Channel[];
  executeAgent: AgentExecutionService;
  queue: GroupQueue;
}

function toAgentLabel(agentType: string): string {
  switch (agentType) {
    case 'claude-code':
      return 'Claude';
    case 'codex':
      return 'Codex';
    case 'copilot':
      return 'Copilot';
    case 'gemini':
      return 'Gemini';
    default:
      return agentType;
  }
}

function stripWorkerTaskLines(text: string): string {
  return text
    .replace(/^\s*TASK_FOR_(COPILOT|GEMINI):.*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractWorkerTasks(text: string): WorkerTaskMap {
  const tasks: WorkerTaskMap = {};
  const matches = text.matchAll(/^\s*TASK_FOR_(COPILOT|GEMINI):\s*(.+)$/gim);
  for (const match of matches) {
    const agent = match[1].toLowerCase() as 'copilot' | 'gemini';
    const body = match[2].trim();
    if (!body) continue;
    tasks[agent] ||= [];
    tasks[agent]!.push(body);
  }
  return tasks;
}

function mergeWorkerTasks(target: WorkerTaskMap, source: WorkerTaskMap): void {
  for (const agent of WORKER_ORDER) {
    const sourceTasks = source[agent];
    if (!sourceTasks || sourceTasks.length === 0) continue;
    target[agent] ||= [];
    target[agent]!.push(...sourceTasks);
  }
}

function shouldAutoRequestWorkerSupport(prompt: string): boolean {
  return prompt.length > 320 || COMPLEX_SUPPORT_RE.test(prompt);
}

function isAgentUnavailableText(text: string): boolean {
  return AGENT_UNAVAILABLE_RE.test(text);
}

function buildPlannerPrompt(opts: {
  basePrompt: string;
  plannerName: string;
  conversationLog: ConversationEntry[];
}): string {
  const history =
    opts.conversationLog.length > 0
      ? `\n\n---\nPrior lead discussion:\n${opts.conversationLog
          .map((entry) => `[${entry.agent}] ${entry.text}`)
          .join('\n\n')}`
      : '';

  return `${opts.basePrompt}${history}

---
Paired-room coordination rules for ${opts.plannerName}:
- You are a user-facing lead agent. Talk directly to the user.
- Claude and Codex are the planners. Copilot and Gemini are support workers.
- Use support workers only for lightweight research, edge-case review, implementation sketching, or simple coding help.
- Your job is judgment, prioritization, and decisions. Do not spend too much time on broad MCP/tool exploration if a support worker can do it for you.
- Offload repo scanning, checklist generation, fact gathering, edge-case hunting, and alternative-path review to support workers whenever that would reduce your own context load.
- If you need support work, append one-line hidden directives in exactly this format:
TASK_FOR_COPILOT: <task>
TASK_FOR_GEMINI: <task>
- Those TASK lines will be consumed by the orchestrator and should not be part of your user-facing explanation.
- Do not ask Copilot or Gemini to debate the user. Keep them as backstage assistants.
- Give a concrete plan, design judgment, and next action.
- Prefer asking for support before doing many parallel MCP lookups yourself.`;
}

function buildWorkerPrompt(opts: {
  basePrompt: string;
  workerName: string;
  conversationLog: ConversationEntry[];
  tasks: string[];
}): string {
  const history =
    opts.conversationLog.length > 0
      ? `\n\nLead context:\n${opts.conversationLog
          .map((entry) => `[${entry.agent}] ${entry.text}`)
          .join('\n\n')}`
      : '';
  const taskLines = opts.tasks
    .map((task, index) => `${index + 1}. ${task}`)
    .join('\n');

  return `${opts.basePrompt}${history}

---
Support-worker instructions for ${opts.workerName}:
- You are a backstage helper for Claude/Codex.
- Do not address the user directly.
- Return only concise findings, options, implementation notes, or edge cases the planners can use.
- Prefer short, high-signal output over polished prose.
- If code is relevant, provide the minimal patch idea or snippet rather than a long essay.
- Reduce load on the lead planner by doing lightweight decomposition, context gathering, and pre-structuring of the answer.
- Act as a pre-processor for the lead planner: gather facts, inspect code, use MCP/tools when useful, and hand back a distilled summary so the planner does not have to do the same exploration.
- Take on the easy but time-consuming work first: check edge cases, list files or components involved, gather missing facts, outline implementation steps, or summarize tradeoffs.
- Be critical, not agreeable-by-default.
- Look for what the lead planner may have missed, assumed too quickly, or oversimplified.
- Challenge weak assumptions, hidden risks, missing constraints, operational issues, testing gaps, and migration hazards.
- Consider at least one alternative framing from a different angle such as product, operations, reliability, security, cost, maintenance, or UX.
- If the current plan seems sound, say what makes it sound and then still provide the strongest remaining concern.
- Do not repeat the planner's answer unless needed for contrast.
- If you used MCP/tools or code inspection, summarize the result in a way the planner can reuse immediately without re-checking everything.
- Prefer this structure when possible:
- Summary:
- Missing or risky points:
- Useful facts or files:
- Recommended next action:
- Good outputs include:
- a cleaner breakdown the planner can reuse
- a shortlist of missing checks
- concrete implementation steps
- one strong objection or alternative path

Tasks:
${taskLines}`;
}

function buildPlannerSynthesisPrompt(opts: {
  basePrompt: string;
  plannerName: string;
  conversationLog: ConversationEntry[];
  workerFindings: WorkerFinding[];
}): string {
  const history =
    opts.conversationLog.length > 0
      ? `\n\nLead discussion so far:\n${opts.conversationLog
          .map((entry) => `[${entry.agent}] ${entry.text}`)
          .join('\n\n')}`
      : '';
  const findings = opts.workerFindings
    .map((finding) => `[${toAgentLabel(finding.agentType)}]\n${finding.text}`)
    .join('\n\n');

  return `${opts.basePrompt}${history}

---
${opts.plannerName} synthesis pass:
- Integrate the support findings below into one clear user-facing update.
- Make decisions instead of dumping raw notes.
- Treat this as a second-pass follow-up after consulting other agents.
- Start with a short label like "Additional review:" or "Follow-up after team review:".
- Keep the answer concise and actionable.
- Explicitly incorporate the strongest useful correction, missing check, or alternative angle from the support workers.
- Do not expose TASK_FOR_* lines or backstage coordination details.

Support findings:
${findings}`;
}

function formatSynthesisFollowUp(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  if (
    /^(additional review|follow-up after team review|team review update|추가 검토|후속 검토)/i.test(
      trimmed,
    )
  ) {
    return trimmed;
  }
  return `Follow-up after team review:\n\n${trimmed}`;
}

function buildFallbackLeadPrompt(opts: {
  basePrompt: string;
  agentName: string;
  unavailableLeads: string[];
}): string {
  const unavailable =
    opts.unavailableLeads.length > 0
      ? opts.unavailableLeads.join(', ')
      : 'the primary planners';

  return `${opts.basePrompt}

---
Fallback lead instructions for ${opts.agentName}:
- ${unavailable} are currently unavailable.
- You are temporarily acting as the public responder for this room.
- Talk directly to the user.
- Give the shortest useful answer that still moves the work forward.
- If you mention the unavailable planners at all, do it in one brief sentence.
  - Focus on concrete next steps, findings, or implementation guidance.`;
}

function getPlannerTimeoutMs(agentType: string): number {
  return agentType === 'codex'
    ? CODEX_PLANNER_TIMEOUT_MS
    : CLAUDE_PLANNER_TIMEOUT_MS;
}

export class PairedRoomService {
  constructor(private readonly deps: PairedRoomServiceDeps) {}

  private async runTimedAgent(
    group: RegisteredGroup,
    prompt: string,
    chatJid: string,
    timeoutMs: number,
    onOutput?: Parameters<AgentExecutionService['runForGroup']>[3],
  ): Promise<'success' | 'error'> {
    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      timedOut = true;
      this.deps.queue.killGroupProcess(
        chatJid,
        `paired-room timeout for ${getAgentType(group)} after ${timeoutMs}ms`,
      );
    }, timeoutMs);

    try {
      const status = await this.deps.executeAgent.runForGroup(
        group,
        prompt,
        chatJid,
        onOutput,
      );
      if (timedOut) {
        logger.warn(
          { chatJid, agentType: getAgentType(group), timeoutMs },
          'Timed agent returned after paired-room timeout',
        );
        return 'error';
      }
      return status;
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
    }
  }

  async process(
    chatJid: string,
    basePrompt: string,
  ): Promise<'success' | 'error'> {
    const allGroups = getAllGroupsForJid(chatJid);
    const activeGroups = allGroups.filter(
      (group) =>
        !isGroupPaused(chatJid, group.agentType ?? 'claude-code') &&
        findChannelForAgent(
          this.deps.channels,
          group.agentType ?? 'claude-code',
        ),
    );

    if (activeGroups.length === 0) {
      logger.info({ chatJid }, 'No active agents in paired room, skipping');
      return 'success';
    }

    const planners = activeGroups
      .filter((group) =>
        PLANNER_ORDER.includes((group.agentType ?? 'claude-code') as never),
      )
      .sort(
        (a, b) =>
          PLANNER_ORDER.indexOf((a.agentType ?? 'claude-code') as never) -
          PLANNER_ORDER.indexOf((b.agentType ?? 'claude-code') as never),
      );

    const workers = activeGroups
      .filter((group) =>
        WORKER_ORDER.includes((group.agentType ?? 'claude-code') as never),
      )
      .sort(
        (a, b) =>
          WORKER_ORDER.indexOf((a.agentType ?? 'claude-code') as never) -
          WORKER_ORDER.indexOf((b.agentType ?? 'claude-code') as never),
      );

    const publicAgents =
      planners.length > 0 ? planners : activeGroups.slice(0, 1);
    const conversationLog: ConversationEntry[] = [];
    const workerTasks: WorkerTaskMap = {};
    const workerFindings: WorkerFinding[] = [];
    let successfulPlannerCount = 0;
    const unavailablePlannerAgents: string[] = [];

    for (const planner of publicAgents) {
      const agentType = getAgentType(planner);
      const rawChunks: string[] = [];
      const publicChunks: string[] = [];
      const plannerTimeoutMs = getPlannerTimeoutMs(agentType);

      const status = await this.runTimedAgent(
        planner,
        buildPlannerPrompt({
          basePrompt,
          plannerName: toAgentLabel(agentType),
          conversationLog,
        }),
        chatJid,
        plannerTimeoutMs,
        async (output) => {
          if (!output.result) return;
          const raw =
            typeof output.result === 'string'
              ? output.result
              : JSON.stringify(output.result);
          if (isAgentUnavailableText(raw)) {
            this.deps.queue.killGroupProcess(
              chatJid,
              `paired-room unavailable planner output from ${agentType}`,
            );
          }
          rawChunks.push(raw);
          const cleaned = stripWorkerTaskLines(raw);
          const text = formatOutbound(cleaned);
          if (!text) return;
          publicChunks.push(text);
          if (agentType === 'codex') {
            this.deps.queue.closeStdin(chatJid);
          }
        },
      );

      if (status === 'error') {
        unavailablePlannerAgents.push(toAgentLabel(agentType));
        logger.warn(
          { chatJid, agentType },
          'Planner agent failed in paired room, falling through to other planners',
        );
        continue;
      }

      const rawReply = rawChunks.join('\n').trim();
      const publicReply = publicChunks.join('\n').trim();
      if (
        isAgentUnavailableText(rawReply) ||
        isAgentUnavailableText(publicReply)
      ) {
        unavailablePlannerAgents.push(toAgentLabel(agentType));
        logger.warn(
          { chatJid, agentType },
          'Planner agent reported an unavailable state in paired room',
        );
        continue;
      }

      successfulPlannerCount++;
      if (publicReply) {
        await this.sendPublicAgentMessage(
          chatJid,
          planner,
          agentType,
          publicReply,
        );
        conversationLog.push({
          agent: toAgentLabel(agentType),
          text: publicReply,
        });
      }
      if (rawReply) {
        mergeWorkerTasks(workerTasks, extractWorkerTasks(rawReply));
      }
    }

    if (successfulPlannerCount === 0) {
      for (const worker of workers) {
        const agentType = getAgentType(worker);
        const fallbackChunks: string[] = [];
        const status = await this.runTimedAgent(
          worker,
          buildFallbackLeadPrompt({
            basePrompt,
            agentName: toAgentLabel(agentType),
            unavailableLeads: unavailablePlannerAgents,
          }),
          chatJid,
          WORKER_TIMEOUT_MS,
          async (output) => {
            if (!output.result) return;
            const raw =
              typeof output.result === 'string'
                ? output.result
                : JSON.stringify(output.result);
            const text = formatOutbound(stripWorkerTaskLines(raw));
            if (text) fallbackChunks.push(text);
          },
        );

        const fallbackReply = fallbackChunks.join('\n').trim();
        if (
          status === 'error' ||
          !fallbackReply ||
          isAgentUnavailableText(fallbackReply)
        ) {
          logger.warn(
            { chatJid, agentType },
            'Worker fallback agent failed in paired room',
          );
          continue;
        }

        await this.sendPublicAgentMessage(
          chatJid,
          worker,
          agentType,
          fallbackReply,
        );
        logger.warn(
          { chatJid, agentType, unavailablePlannerAgents },
          'Worker agent used as public fallback in paired room',
        );
        return 'success';
      }

      logger.error(
        { chatJid, unavailablePlannerAgents },
        'All planner agents failed in paired room',
      );
      return 'error';
    }

    if (
      workers.length > 0 &&
      Object.keys(workerTasks).length === 0 &&
      shouldAutoRequestWorkerSupport(basePrompt)
    ) {
      if (workers.some((group) => getAgentType(group) === 'copilot')) {
        workerTasks.copilot = [
          'Do the support work the lead planner should not spend time on: inspect the codebase, break the plan into implementation steps, identify touched files/components, suggest small concrete code changes, and point out the strongest hidden risk or missing check.',
        ];
      }
      if (workers.some((group) => getAgentType(group) === 'gemini')) {
        workerTasks.gemini = [
          'Gather missing context from a different angle than the lead planner. Use tools or MCP if useful, surface edge cases, external constraints, alternative approaches, and non-obvious tradeoffs, and summarize the most reusable facts for the planner.',
        ];
      }
    }

    for (const worker of workers) {
      const agentType = getAgentType(worker) as 'copilot' | 'gemini';
      const tasks = workerTasks[agentType];
      if (!tasks || tasks.length === 0) continue;

      const workerChunks: string[] = [];
      const status = await this.runTimedAgent(
        worker,
        buildWorkerPrompt({
          basePrompt,
          workerName: toAgentLabel(agentType),
          conversationLog,
          tasks,
        }),
        chatJid,
        WORKER_TIMEOUT_MS,
        async (output) => {
          if (!output.result) return;
          const raw =
            typeof output.result === 'string'
              ? output.result
              : JSON.stringify(output.result);
          const text = formatOutbound(raw);
          if (text) workerChunks.push(text);
        },
      );

      if (status === 'error') {
        logger.warn(
          { chatJid, agentType },
          'Worker agent failed in paired room',
        );
        continue;
      }

      const finding = workerChunks.join('\n').trim();
      if (finding) {
        workerFindings.push({ agentType, text: finding });
      }
    }

    if (workerFindings.length === 0) {
      return 'success';
    }

    const synthesisPlanner =
      planners.find((group) => getAgentType(group) === 'codex') ||
      planners[planners.length - 1];
    if (!synthesisPlanner) return 'success';

    const synthesisAgentType = getAgentType(synthesisPlanner);
    const synthesisStatus = await this.runTimedAgent(
      synthesisPlanner,
      buildPlannerSynthesisPrompt({
        basePrompt,
        plannerName: toAgentLabel(synthesisAgentType),
        conversationLog,
        workerFindings,
      }),
      chatJid,
      getPlannerTimeoutMs(synthesisAgentType),
      async (output) => {
        if (!output.result) return;
        const raw =
          typeof output.result === 'string'
            ? output.result
            : JSON.stringify(output.result);
        const text = formatOutbound(stripWorkerTaskLines(raw));
        if (!text) return;
        if (synthesisAgentType === 'codex') {
          this.deps.queue.closeStdin(chatJid);
        }
        await this.sendPublicAgentMessage(
          chatJid,
          synthesisPlanner,
          synthesisAgentType,
          formatSynthesisFollowUp(text),
        );
      },
    );

    if (synthesisStatus === 'error' && successfulPlannerCount > 0) {
      logger.warn(
        { chatJid, synthesisAgentType },
        'Synthesis planner failed, but earlier planner output already succeeded',
      );
      return 'success';
    }

    return synthesisStatus;
  }

  private async sendPublicAgentMessage(
    chatJid: string,
    group: RegisteredGroup,
    agentType: string,
    text: string,
  ): Promise<void> {
    const channel = findChannelForAgent(this.deps.channels, agentType);
    if (!channel) {
      throw new Error(`No channel for paired-room agent ${agentType}`);
    }
    const itemId = createWorkItem({
      group_folder: group.folder,
      chat_jid: chatJid,
      agent_type: agentType,
      result_payload: text,
    });
    try {
      await channel.sendMessage(chatJid, text);
      markWorkItemDelivered(itemId);
    } catch (err) {
      markWorkItemFailed(itemId, String(err));
      throw err;
    }
  }
}
