/**
 * MCP tool handler functions — pure business logic with no SDK dependencies.
 * Extracted from ipc-mcp-stdio.ts for testability (kaizen #167).
 *
 * Each handler takes (args, config) and returns an MCP-compatible result.
 * The MCP server in ipc-mcp-stdio.ts wires these to tool registrations.
 */

import fs from 'fs';
import path from 'path';
import { validateScheduleValue } from './validation.js';
import { writeIpcFile, pollForResult } from './ipc-utils.js';

export interface McpConfig {
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
  ipcDir: string;
}

export interface McpResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function messagesDir(config: McpConfig): string {
  return path.join(config.ipcDir, 'messages');
}

function tasksDir(config: McpConfig): string {
  return path.join(config.ipcDir, 'tasks');
}

// send_message

export async function handleSendMessage(
  args: { text: string; sender?: string },
  config: McpConfig,
): Promise<McpResult> {
  const data: Record<string, string | undefined> = {
    type: 'message',
    chatJid: config.chatJid,
    text: args.text,
    sender: args.sender || undefined,
    groupFolder: config.groupFolder,
    timestamp: new Date().toISOString(),
  };

  writeIpcFile(messagesDir(config), data);
  return { content: [{ type: 'text', text: 'Message sent.' }] };
}

// send_image

export async function handleSendImage(
  args: { image_path: string; caption?: string },
  config: McpConfig,
): Promise<McpResult> {
  if (!fs.existsSync(args.image_path)) {
    return {
      content: [
        { type: 'text', text: `Image file not found: ${args.image_path}` },
      ],
      isError: true,
    };
  }

  const data: Record<string, string | undefined> = {
    type: 'image',
    chatJid: config.chatJid,
    imagePath: args.image_path,
    caption: args.caption || undefined,
    groupFolder: config.groupFolder,
    timestamp: new Date().toISOString(),
  };

  writeIpcFile(messagesDir(config), data);
  return { content: [{ type: 'text', text: 'Image sent.' }] };
}

// send_document

export async function handleSendDocument(
  args: { document_path: string; filename?: string; caption?: string },
  config: McpConfig,
): Promise<McpResult> {
  if (!fs.existsSync(args.document_path)) {
    return {
      content: [
        {
          type: 'text',
          text: `Document file not found: ${args.document_path}`,
        },
      ],
      isError: true,
    };
  }

  const data: Record<string, string | undefined> = {
    type: 'document',
    chatJid: config.chatJid,
    documentPath: args.document_path,
    filename: args.filename || undefined,
    caption: args.caption || undefined,
    groupFolder: config.groupFolder,
    timestamp: new Date().toISOString(),
  };

  writeIpcFile(messagesDir(config), data);
  return { content: [{ type: 'text', text: 'Document sent.' }] };
}

// schedule_task

export async function handleScheduleTask(
  args: {
    prompt: string;
    schedule_type: 'cron' | 'interval' | 'once';
    schedule_value: string;
    context_mode: 'group' | 'isolated';
    target_group_jid?: string;
  },
  config: McpConfig,
): Promise<McpResult> {
  const validation = validateScheduleValue(
    args.schedule_type,
    args.schedule_value,
  );
  if (!validation.valid) {
    return {
      content: [{ type: 'text', text: validation.error! }],
      isError: true,
    };
  }

  const targetJid =
    config.isMain && args.target_group_jid
      ? args.target_group_jid
      : config.chatJid;

  const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const data = {
    type: 'schedule_task',
    taskId,
    prompt: args.prompt,
    schedule_type: args.schedule_type,
    schedule_value: args.schedule_value,
    context_mode: args.context_mode || 'group',
    targetJid,
    createdBy: config.groupFolder,
    timestamp: new Date().toISOString(),
  };

  writeIpcFile(tasksDir(config), data);

  return {
    content: [
      {
        type: 'text',
        text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}`,
      },
    ],
  };
}

// list_tasks

export async function handleListTasks(config: McpConfig): Promise<McpResult> {
  const tasksFile = path.join(config.ipcDir, 'current_tasks.json');

  try {
    if (!fs.existsSync(tasksFile)) {
      return {
        content: [{ type: 'text', text: 'No scheduled tasks found.' }],
      };
    }

    const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

    const tasks = config.isMain
      ? allTasks
      : allTasks.filter(
          (t: { groupFolder: string }) => t.groupFolder === config.groupFolder,
        );

    if (tasks.length === 0) {
      return {
        content: [{ type: 'text', text: 'No scheduled tasks found.' }],
      };
    }

    const formatted = tasks
      .map(
        (t: {
          id: string;
          prompt: string;
          schedule_type: string;
          schedule_value: string;
          status: string;
          next_run: string;
        }) =>
          `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
      )
      .join('\n');

    return {
      content: [{ type: 'text', text: `Scheduled tasks:\n${formatted}` }],
    };
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
}

// list_cases

export async function handleListCases(config: McpConfig): Promise<McpResult> {
  const casesFile = path.join(config.ipcDir, 'active_cases.json');

  try {
    if (!fs.existsSync(casesFile)) {
      return {
        content: [{ type: 'text', text: 'No active cases.' }],
      };
    }

    const cases = JSON.parse(fs.readFileSync(casesFile, 'utf-8'));
    if (cases.length === 0) {
      return {
        content: [{ type: 'text', text: 'No active cases.' }],
      };
    }

    const formatted = cases
      .map(
        (c: {
          name: string;
          type: string;
          status: string;
          description: string;
          last_message: string | null;
          last_activity_at: string | null;
          total_cost_usd: number;
          time_spent_ms: number;
          blocked_on: string | null;
          initiator: string;
        }) => {
          const blocked = c.blocked_on ? ` [blocked: ${c.blocked_on}]` : '';
          const cost =
            c.total_cost_usd > 0 ? `$${c.total_cost_usd.toFixed(2)}` : '$0';
          return `- [${c.name}] (${c.type}, ${c.status}${blocked}) — ${c.description.slice(0, 80)}\n  Last: "${(c.last_message || 'none').slice(0, 60)}" | Cost: ${cost} | By: ${c.initiator}`;
        },
      )
      .join('\n');

    return {
      content: [{ type: 'text', text: `Active cases:\n${formatted}` }],
    };
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: `Error reading cases: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
}

// case_mark_done — L3 enforcement

export async function handleCaseMarkDone(
  args: {
    case_id: string;
    conclusion: string;
    kaizen?: Array<{
      issue: string;
      suggestion: string;
      severity: 'low' | 'medium' | 'high';
    }>;
    no_kaizen_needed?: boolean;
    no_kaizen_reason?: string;
  },
  config: McpConfig,
): Promise<McpResult> {
  // L3 enforcement (kaizen #57): require either kaizen reflections or explicit opt-out
  const hasKaizen = args.kaizen && args.kaizen.length > 0;
  const hasOptOut =
    args.no_kaizen_needed === true &&
    args.no_kaizen_reason &&
    args.no_kaizen_reason.trim().length > 0;

  if (!hasKaizen && !hasOptOut) {
    return {
      content: [
        {
          type: 'text',
          text: 'Rejected: You must provide either a non-empty kaizen array with reflections, or set no_kaizen_needed=true with a no_kaizen_reason explaining why no improvements were identified. Empty reflections are not allowed — every case teaches something.',
        },
      ],
      isError: true,
    };
  }

  const data = {
    type: 'case_mark_done',
    caseId: args.case_id,
    conclusion: args.conclusion,
    noKaizenNeeded: args.no_kaizen_needed || false,
    noKaizenReason: args.no_kaizen_reason || '',
    groupFolder: config.groupFolder,
    timestamp: new Date().toISOString(),
  };

  writeIpcFile(tasksDir(config), data);

  // Submit each kaizen reflection as a suggested dev case
  if (hasKaizen) {
    for (const k of args.kaizen!) {
      const suggestData = {
        type: 'case_suggest_dev',
        sourceCaseId: args.case_id,
        description: `[${k.severity}] ${k.issue} → ${k.suggestion}`,
        groupFolder: config.groupFolder,
        chatJid: config.chatJid,
        timestamp: new Date().toISOString(),
      };
      writeIpcFile(tasksDir(config), suggestData);
    }
  }

  const kaizenCount = args.kaizen?.length || 0;
  return {
    content: [
      {
        type: 'text',
        text: `Case ${args.case_id} marked as done. Awaiting review.${kaizenCount > 0 ? ` ${kaizenCount} kaizen suggestion(s) submitted.` : hasOptOut ? ' No kaizen needed: ' + args.no_kaizen_reason : ''}`,
      },
    ],
  };
}

// Simple IPC-only handlers (pause, resume, cancel, update, mark_blocked, mark_active, etc.)

export async function handlePauseTask(
  args: { task_id: string },
  config: McpConfig,
): Promise<McpResult> {
  writeIpcFile(tasksDir(config), {
    type: 'pause_task',
    taskId: args.task_id,
    groupFolder: config.groupFolder,
    isMain: config.isMain,
    timestamp: new Date().toISOString(),
  });
  return {
    content: [{ type: 'text', text: `Task ${args.task_id} pause requested.` }],
  };
}

export async function handleResumeTask(
  args: { task_id: string },
  config: McpConfig,
): Promise<McpResult> {
  writeIpcFile(tasksDir(config), {
    type: 'resume_task',
    taskId: args.task_id,
    groupFolder: config.groupFolder,
    isMain: config.isMain,
    timestamp: new Date().toISOString(),
  });
  return {
    content: [{ type: 'text', text: `Task ${args.task_id} resume requested.` }],
  };
}

export async function handleCancelTask(
  args: { task_id: string },
  config: McpConfig,
): Promise<McpResult> {
  writeIpcFile(tasksDir(config), {
    type: 'cancel_task',
    taskId: args.task_id,
    groupFolder: config.groupFolder,
    isMain: config.isMain,
    timestamp: new Date().toISOString(),
  });
  return {
    content: [
      { type: 'text', text: `Task ${args.task_id} cancellation requested.` },
    ],
  };
}

export async function handleUpdateTask(
  args: {
    task_id: string;
    prompt?: string;
    schedule_type?: 'cron' | 'interval' | 'once';
    schedule_value?: string;
  },
  config: McpConfig,
): Promise<McpResult> {
  if (args.schedule_value && args.schedule_type) {
    const validation = validateScheduleValue(
      args.schedule_type,
      args.schedule_value,
    );
    if (!validation.valid) {
      return {
        content: [{ type: 'text', text: validation.error! }],
        isError: true,
      };
    }
  } else if (args.schedule_value && !args.schedule_type) {
    const validation = validateScheduleValue('cron', args.schedule_value);
    if (!validation.valid) {
      return {
        content: [{ type: 'text', text: validation.error! }],
        isError: true,
      };
    }
  }

  const data: Record<string, string | undefined> = {
    type: 'update_task',
    taskId: args.task_id,
    groupFolder: config.groupFolder,
    isMain: String(config.isMain),
    timestamp: new Date().toISOString(),
  };
  if (args.prompt !== undefined) data.prompt = args.prompt;
  if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
  if (args.schedule_value !== undefined)
    data.schedule_value = args.schedule_value;

  writeIpcFile(tasksDir(config), data);

  return {
    content: [{ type: 'text', text: `Task ${args.task_id} update requested.` }],
  };
}

export async function handleRegisterGroup(
  args: { jid: string; name: string; folder: string; trigger: string },
  config: McpConfig,
): Promise<McpResult> {
  if (!config.isMain) {
    return {
      content: [
        { type: 'text', text: 'Only the main group can register new groups.' },
      ],
      isError: true,
    };
  }

  writeIpcFile(tasksDir(config), {
    type: 'register_group',
    jid: args.jid,
    name: args.name,
    folder: args.folder,
    trigger: args.trigger,
    timestamp: new Date().toISOString(),
  });

  return {
    content: [
      {
        type: 'text',
        text: `Group "${args.name}" registered. It will start receiving messages immediately.`,
      },
    ],
  };
}

export async function handleCaseMarkBlocked(
  args: { case_id: string; blocked_on: string },
  config: McpConfig,
): Promise<McpResult> {
  writeIpcFile(tasksDir(config), {
    type: 'case_mark_blocked',
    caseId: args.case_id,
    blocked_on: args.blocked_on,
    groupFolder: config.groupFolder,
    timestamp: new Date().toISOString(),
  });
  return {
    content: [
      {
        type: 'text',
        text: `Case ${args.case_id} marked as blocked on: ${args.blocked_on}`,
      },
    ],
  };
}

export async function handleAddCaseComment(
  args: { case_id: string; text: string; author?: string },
  config: McpConfig,
): Promise<McpResult> {
  writeIpcFile(tasksDir(config), {
    type: 'case_add_comment',
    caseId: args.case_id,
    text: args.text,
    author: args.author || 'agent',
    groupFolder: config.groupFolder,
    timestamp: new Date().toISOString(),
  });
  return {
    content: [{ type: 'text', text: `Comment added to case ${args.case_id}.` }],
  };
}

export async function handleAttachCaseArtifact(
  args: {
    case_id: string;
    artifact_type: 'file' | 'link' | 'note';
    value: string;
    description?: string;
  },
  config: McpConfig,
): Promise<McpResult> {
  const label =
    args.artifact_type === 'file'
      ? '📎'
      : args.artifact_type === 'link'
        ? '🔗'
        : '📝';
  const desc = args.description ? ` — ${args.description}` : '';
  const text = `${label} **Artifact (${args.artifact_type}):** ${args.value}${desc}`;

  writeIpcFile(tasksDir(config), {
    type: 'case_add_comment',
    caseId: args.case_id,
    text,
    author: 'agent',
    groupFolder: config.groupFolder,
    timestamp: new Date().toISOString(),
  });
  return {
    content: [
      {
        type: 'text',
        text: `Artifact attached to case ${args.case_id}: ${args.artifact_type} — ${args.value}`,
      },
    ],
  };
}

export async function handleCaseMarkActive(
  args: { case_id: string },
  config: McpConfig,
): Promise<McpResult> {
  writeIpcFile(tasksDir(config), {
    type: 'case_mark_active',
    caseId: args.case_id,
    groupFolder: config.groupFolder,
    timestamp: new Date().toISOString(),
  });
  return {
    content: [{ type: 'text', text: `Case ${args.case_id} resumed.` }],
  };
}

export async function handleCaseSuggestDev(
  args: { source_case_id: string; description: string },
  config: McpConfig,
): Promise<McpResult> {
  writeIpcFile(tasksDir(config), {
    type: 'case_suggest_dev',
    sourceCaseId: args.source_case_id,
    description: args.description,
    groupFolder: config.groupFolder,
    chatJid: config.chatJid,
    timestamp: new Date().toISOString(),
  });
  return {
    content: [
      {
        type: 'text',
        text: `Dev case suggested from ${args.source_case_id}. User will be notified for approval.`,
      },
    ],
  };
}

export async function handleCreateCase(
  args: {
    short_name?: string;
    description: string;
    context?: string;
    case_type: 'work' | 'dev';
    customer_name?: string;
    customer_phone?: string;
    customer_email?: string;
    customer_org?: string;
    github_issue?: number;
    gap_type?: string;
    signals?: Record<string, boolean>;
    branch_name?: string;
    worktree_path?: string;
  },
  config: McpConfig,
): Promise<McpResult> {
  const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const data: Record<string, unknown> = {
    type: 'case_create',
    shortName: args.short_name,
    description: args.description,
    context: args.context,
    caseType: args.case_type || 'work',
    chatJid: config.chatJid,
    initiator: 'agent',
    groupFolder: config.groupFolder,
    requestId,
    timestamp: new Date().toISOString(),
    ...(args.github_issue ? { githubIssue: args.github_issue } : {}),
    ...(args.gap_type ? { gapType: args.gap_type } : {}),
    ...(args.signals ? { signals: args.signals } : {}),
  };
  if (args.customer_name) data.customer_name = args.customer_name;
  if (args.customer_phone) data.customer_phone = args.customer_phone;
  if (args.customer_email) data.customer_email = args.customer_email;
  if (args.customer_org) data.customer_org = args.customer_org;
  if (args.branch_name) data.branchName = args.branch_name;
  if (args.worktree_path) data.worktreePath = args.worktree_path;

  writeIpcFile(tasksDir(config), data);

  const result = await pollForResult(
    path.join(config.ipcDir, 'case_results'),
    requestId,
  );
  if (result) {
    if (result.needs_approval) {
      return {
        content: [
          {
            type: 'text',
            text: `Dev case suggested (pending approval):\n  ID: ${result.id}\n  Name: ${result.name}\n  Status: SUGGESTED — awaiting approval from main group\n\nThe case needs approval before it becomes active. The main group has been notified. Do NOT start working on this case until it is approved.`,
          },
        ],
      };
    }
    const parts = [
      `Case created:\n  ID: ${result.id}\n  Name: ${result.name}\n  Workspace: ${result.workspace_path}${result.issue_url ? `\n  GitHub: ${result.issue_url}` : ''}`,
    ];
    if (result.priority) {
      parts.push(
        `  Priority: ${result.priority}${result.gap_type ? ` (gap: ${result.gap_type})` : ''}`,
      );
    }
    if (result.meanwhile) {
      parts.push(`\nMeanwhile message for the customer: "${result.meanwhile}"`);
    }
    parts.push(
      '\nThe case is now ACTIVE. Future messages about this topic will be routed to it.',
    );
    return { content: [{ type: 'text', text: parts.join('\n') }] };
  }

  return {
    content: [
      {
        type: 'text',
        text: `Case creation requested for: "${args.description}". It should appear shortly in the active cases list.`,
      },
    ],
  };
}

export async function handleCreateGithubIssue(
  args: {
    title: string;
    body: string;
    owner: string;
    repo: string;
    labels: string[];
  },
  config: McpConfig,
): Promise<McpResult> {
  const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  writeIpcFile(tasksDir(config), {
    type: 'create_github_issue',
    owner: args.owner || 'Garsson-io',
    repo: args.repo || 'kaizen',
    title: args.title,
    body: args.body,
    labels: args.labels || ['work-agent', 'needs-dev'],
    requestId,
    timestamp: new Date().toISOString(),
  });

  const result = await pollForResult(
    path.join(config.ipcDir, 'issue_results'),
    requestId,
  );
  if (result) {
    if (result.success) {
      return {
        content: [
          {
            type: 'text',
            text: `Issue created: ${result.issueUrl}\nNumber: #${result.issueNumber}`,
          },
        ],
      };
    } else {
      return {
        content: [
          { type: 'text', text: `Failed to create issue: ${result.error}` },
        ],
        isError: true,
      };
    }
  }

  return {
    content: [
      {
        type: 'text',
        text: 'Issue creation requested but timed out waiting for confirmation. The host may still process it.',
      },
    ],
  };
}

export async function handleRouteDecision(
  args: {
    request_id: string;
    decision: 'route_to_case' | 'direct_answer' | 'suggest_new';
    case_id?: string;
    case_name?: string;
    confidence: number;
    reason: string;
    direct_answer?: string;
  },
  config: McpConfig,
): Promise<McpResult> {
  const resultsDir = path.join(config.ipcDir, 'results');
  const fs = await import('fs');
  fs.mkdirSync(resultsDir, { recursive: true });

  const result = {
    requestId: args.request_id,
    decision: args.decision,
    caseId: args.case_id,
    caseName: args.case_name,
    confidence: args.confidence,
    reason: args.reason,
    directAnswer: args.direct_answer,
    timestamp: new Date().toISOString(),
  };

  const filepath = path.join(resultsDir, `${args.request_id}.json`);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(result, null, 2));
  fs.renameSync(tempPath, filepath);

  return {
    content: [
      {
        type: 'text',
        text: `Routing decision submitted: ${args.decision}${args.case_name ? ` → ${args.case_name}` : ''}`,
      },
    ],
  };
}
