/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';
import { SonosDevice, SonosManager } from '@svrooij/sonos';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times. Note: when running as a scheduled task, your final output is NOT sent to the user — use this tool if you need to communicate with the user or group.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use ISO 8601 format like "2026-02-01T15:30:00.000Z".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const data = {
      type: 'schedule_task',
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    const filename = writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task scheduled (${filename}): ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new WhatsApp group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name should be lowercase with hyphens (e.g., "family-chat").`,
  {
    jid: z.string().describe('The WhatsApp JID (e.g., "120363336345536173@g.us")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Folder name for group files (lowercase, hyphens, e.g., "family-chat")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

server.tool(
  'self_update',
  `Pull the latest code, rebuild, and restart the orchestrator. Main group only.

Use when asked to "pull latest", "update yourself", "deploy new code", or "checkout branch X".
Optionally specify a branch to checkout before pulling. The container will terminate during restart — this is expected.`,
  {
    branch: z
      .string()
      .optional()
      .describe(
        'Git branch to checkout before pulling (e.g., "main", "feat/new-feature"). Omit to pull the current branch.',
      ),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can trigger a self-update.',
          },
        ],
        isError: true,
      };
    }

    const data: Record<string, string | undefined> = {
      type: 'self_update',
      branch: args.branch || undefined,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Self-update requested${args.branch ? ` (branch: ${args.branch})` : ''}. The orchestrator will pull, build, and restart. This container will terminate during the restart.`,
        },
      ],
    };
  },
);

// Sonos control
const SONOS_CONTROL_MODE = process.env.SONOS_CONTROL_MODE || 'local'; // 'local' | 'cloud'
const SONOS_SPEAKER_IP = process.env.SONOS_SPEAKER_IP;
const SONOS_TTS_ENDPOINT = process.env.SONOS_TTS_ENDPOINT || 'https://api.streamelements.com/kappa/v2/speech';
const SONOS_ACCESS_TOKEN = process.env.SONOS_ACCESS_TOKEN;
const SONOS_HOUSEHOLD_ID = process.env.SONOS_HOUSEHOLD_ID;

let sonosDevice: SonosDevice | null = null;
let sonosManager: SonosManager | null = null;

async function getSonosDevice(): Promise<SonosDevice> {
  if (sonosDevice) return sonosDevice;

  if (!SONOS_SPEAKER_IP) {
    throw new Error('SONOS_SPEAKER_IP environment variable not set. Please configure a speaker IP address.');
  }

  sonosDevice = new SonosDevice(SONOS_SPEAKER_IP);
  await sonosDevice.LoadDeviceData();
  return sonosDevice;
}

// Cloud API helpers
async function sonosCloudRequest(endpoint: string, options: { method?: string; body?: unknown } = {}): Promise<unknown> {
  if (!SONOS_ACCESS_TOKEN) {
    throw new Error('SONOS_ACCESS_TOKEN not set. Run OAuth setup first.');
  }
  if (!SONOS_HOUSEHOLD_ID) {
    throw new Error('SONOS_HOUSEHOLD_ID not set. Run OAuth setup first.');
  }

  const response = await fetch(`https://api.ws.sonos.com/control/api/v1/households/${SONOS_HOUSEHOLD_ID}${endpoint}`, {
    method: options.method || 'GET',
    headers: {
      'Authorization': `Bearer ${SONOS_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Sonos Cloud API error: ${response.status} ${error}`);
  }

  return response.json();
}

server.tool(
  'sonos',
  `Control Sonos speakers - play/pause music, adjust volume, send TTS announcements.

Mode: ${SONOS_CONTROL_MODE} (local = LAN control, cloud = OAuth API)

Actions:
- discover: Find all Sonos speakers on network (local mode only)
- play: Resume playback
- pause: Pause playback
- next: Skip to next track
- previous: Go to previous track
- volume: Get or set volume (0-100)
- tts: Send text-to-speech announcement (local mode only)
- status: Get current playback status
- groups: List available groups/rooms (cloud mode only)`,
  {
    action: z.enum(['play', 'pause', 'next', 'previous', 'volume', 'tts', 'discover', 'status', 'groups']).describe('Action to perform'),
    volume: z.number().min(0).max(100).optional().describe('Volume level (0-100) for volume or tts actions'),
    text: z.string().optional().describe('Text to speak for TTS action'),
    lang: z.string().optional().describe('Language code for TTS (e.g., en-US, es-ES)'),
    groupId: z.string().optional().describe('Group ID for cloud mode operations'),
  },
  async (args) => {
    try {
      let result: string;
      const useCloud = SONOS_CONTROL_MODE === 'cloud';

      switch (args.action) {
        case 'discover': {
          if (useCloud) {
            throw new Error('Discovery only available in local mode. Use "groups" action for cloud mode.');
          }
          if (!sonosManager) {
            sonosManager = new SonosManager();
          }
          await sonosManager.InitializeWithDiscovery(10);
          const devices = sonosManager.Devices.map(d =>
            `- ${d.Name} (${d.Host}) - Group: ${d.GroupName}`
          ).join('\n');
          result = `Found ${sonosManager.Devices.length} Sonos speaker(s):\n${devices}`;
          break;
        }

        case 'groups': {
          if (!useCloud) {
            throw new Error('Groups action only available in cloud mode.');
          }
          const data = await sonosCloudRequest('/groups') as { groups: Array<{ id: string; name: string }> };
          const groupsList = data.groups.map(g => `- ${g.name} (${g.id})`).join('\n');
          result = `Available groups:\n${groupsList}`;
          break;
        }

        case 'play': {
          if (useCloud) {
            const groupId = args.groupId || SONOS_HOUSEHOLD_ID;
            await sonosCloudRequest(`/groups/${groupId}/playback/play`, { method: 'POST' });
            result = `▶️ Playing on group ${groupId}`;
          } else {
            const device = await getSonosDevice();
            await device.Play();
            result = `▶️ Playing on ${device.Name}`;
          }
          break;
        }

        case 'pause': {
          if (useCloud) {
            const groupId = args.groupId || SONOS_HOUSEHOLD_ID;
            await sonosCloudRequest(`/groups/${groupId}/playback/pause`, { method: 'POST' });
            result = `⏸️ Paused on group ${groupId}`;
          } else {
            const device = await getSonosDevice();
            await device.Pause();
            result = `⏸️ Paused on ${device.Name}`;
          }
          break;
        }

        case 'next': {
          if (useCloud) {
            const groupId = args.groupId || SONOS_HOUSEHOLD_ID;
            await sonosCloudRequest(`/groups/${groupId}/playback/skipToNextTrack`, { method: 'POST' });
            result = `⏭️ Skipped to next track on group ${groupId}`;
          } else {
            const device = await getSonosDevice();
            await device.Next();
            result = `⏭️ Skipped to next track on ${device.Name}`;
          }
          break;
        }

        case 'previous': {
          if (useCloud) {
            const groupId = args.groupId || SONOS_HOUSEHOLD_ID;
            await sonosCloudRequest(`/groups/${groupId}/playback/skipToPreviousTrack`, { method: 'POST' });
            result = `⏮️ Back to previous track on group ${groupId}`;
          } else {
            const device = await getSonosDevice();
            await device.Previous();
            result = `⏮️ Back to previous track on ${device.Name}`;
          }
          break;
        }

        case 'volume': {
          if (useCloud) {
            const groupId = args.groupId || SONOS_HOUSEHOLD_ID;
            if (args.volume === undefined) {
              const data = await sonosCloudRequest(`/groups/${groupId}/groupVolume`) as { volume: number };
              result = `🔊 Current volume: ${data.volume}`;
            } else {
              await sonosCloudRequest(`/groups/${groupId}/groupVolume`, {
                method: 'POST',
                body: { volume: args.volume },
              });
              result = `🔊 Volume set to ${args.volume} on group ${groupId}`;
            }
          } else {
            const device = await getSonosDevice();
            if (args.volume === undefined) {
              const vol = await device.RenderingControlService.GetVolume({ InstanceID: 0, Channel: 'Master' });
              result = `🔊 Current volume: ${vol.CurrentVolume}`;
            } else {
              await device.SetVolume(args.volume);
              result = `🔊 Volume set to ${args.volume} on ${device.Name}`;
            }
          }
          break;
        }

        case 'tts': {
          if (useCloud) {
            throw new Error('TTS only available in local mode. Cloud API does not support TTS.');
          }
          if (!args.text) {
            throw new Error('TTS requires text parameter');
          }
          const device = await getSonosDevice();
          await device.PlayTTS({
            text: args.text,
            lang: args.lang || 'en-US',
            gender: 'male',
            volume: args.volume || 50,
            endpoint: SONOS_TTS_ENDPOINT,
          });
          result = `🔊 TTS announcement sent to ${device.Name}`;
          break;
        }

        case 'status': {
          if (useCloud) {
            const groupId = args.groupId || SONOS_HOUSEHOLD_ID;
            const data = await sonosCloudRequest(`/groups/${groupId}/playbackMetadata`) as {
              container: { name: string };
              currentItem: { track: { name: string; artist: { name: string } } };
            };
            result = [
              `📊 Status for group ${groupId}:`,
              `Playing: ${data.currentItem?.track?.name || 'Unknown'}`,
              `Artist: ${data.currentItem?.track?.artist?.name || 'Unknown'}`,
            ].join('\n');
          } else {
            const device = await getSonosDevice();
            const state = await device.AVTransportService.GetTransportInfo();
            const position = await device.AVTransportService.GetPositionInfo();
            const volume = await device.RenderingControlService.GetVolume({ InstanceID: 0, Channel: 'Master' });

            result = [
              `📊 Status for ${device.Name}:`,
              `State: ${state.CurrentTransportState}`,
              `Track: ${position.TrackMetaData ? 'Playing' : 'Stopped'}`,
              `Volume: ${volume.CurrentVolume}`,
              `Group: ${device.GroupName}`,
            ].join('\n');
          }
          break;
        }

        default:
          throw new Error(`Unknown action: ${args.action}`);
      }

      return { content: [{ type: 'text' as const, text: result }] };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text' as const, text: `❌ Sonos error: ${errorMessage}` }],
        isError: true,
      };
    }
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
