import Anthropic from "@anthropic-ai/sdk";

import {
  ASSISTANT_NAME,
  COORDINATOR_MAX_HISTORY,
  COORDINATOR_MAX_TOKENS,
  COORDINATOR_MODEL,
  CREDENTIAL_PROXY_PORT,
} from "./config.js";
import { detectAuthMode } from "./credential-proxy.js";
import { logger } from "./logger.js";
import type { WorkspaceManager } from "./workspace-manager.js";

type MessageParam = Anthropic.Messages.MessageParam;
type ContentBlock = Anthropic.Messages.ContentBlock;
type ToolUseBlock = Anthropic.Messages.ToolUseBlock;

const COORDINATOR_TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: "respond",
    description:
      "Send a direct reply to the user. Use this for simple questions, conversation, and status updates. No container is started.",
    input_schema: {
      type: "object" as const,
      properties: {
        text: { type: "string", description: "The reply text to send to the user." },
      },
      required: ["text"],
    },
  },
  {
    name: "start_workspace",
    description:
      "Start a named background container (Workspace) to handle a heavy task such as file operations, code execution, or long-running research. Returns immediately; results arrive via progress notifications.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description:
            "Short alphanumeric identifier for the workspace (e.g. 'deploy', 'research'). Used as the workspace label.",
        },
        prompt: {
          type: "string",
          description: "Full instructions for what the workspace should accomplish.",
        },
      },
      required: ["name", "prompt"],
    },
  },
  {
    name: "send_to_workspace",
    description:
      "Send an additional message or instruction to an already-running workspace container.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "The workspace name to target." },
        message: { type: "string", description: "The message or instruction to send." },
      },
      required: ["name", "message"],
    },
  },
  {
    name: "workspace_status",
    description: "List all workspaces for this chat and their current status.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "stop_workspace",
    description: "Stop a running workspace container.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "The workspace name to stop." },
      },
      required: ["name"],
    },
  },
];

interface CoordinatorState {
  chatJid: string;
  history: MessageParam[];
}

export interface CoordinatorDeps {
  workspaceManager: WorkspaceManager;
  sendMessage: (chatJid: string, text: string) => Promise<void>;
  setTyping?: (chatJid: string, typing: boolean) => Promise<void>;
}

function buildSystemPrompt(chatJid: string, workspaceManager: WorkspaceManager): string {
  const workspaces = workspaceManager.getWorkspaces(chatJid);
  const workspaceSummary =
    workspaces.length > 0
      ? workspaces
          .map((w) => `  - ${w.name}: ${w.status} (started ${w.startedAt})`)
          .join("\n")
      : "  (none)";

  return `You are ${ASSISTANT_NAME}, a personal AI assistant.

You receive messages from the user and decide how to respond:
1. **Simple questions or conversation** → use the \`respond\` tool to reply directly (no container needed, fast).
2. **Heavy tasks** (file operations, code execution, research, long-running work) → use \`start_workspace\` to launch a background container. The workspace will send progress updates as it works.
3. **Follow-up instructions for a running workspace** → use \`send_to_workspace\`.
4. **Status check** → use \`workspace_status\`.
5. **Stop a workspace** → use \`stop_workspace\`.

Always use the \`respond\` tool to reply — never output raw text directly.

When a workspace sends progress, relay it to the user naturally:
  e.g. "[deploy] Files updated successfully."

<active_workspaces>
${workspaceSummary}
</active_workspaces>`;
}

export class Coordinator {
  private client: Anthropic;
  private states = new Map<string, CoordinatorState>();

  constructor(private deps: CoordinatorDeps) {
    const authMode = detectAuthMode();
    this.client = new Anthropic({
      baseURL: `http://127.0.0.1:${CREDENTIAL_PROXY_PORT}`,
      apiKey: "placeholder",
      ...(authMode === "oauth" && {
        defaultHeaders: { Authorization: "Bearer placeholder" },
      }),
    });
  }

  private getOrCreateState(chatJid: string): CoordinatorState {
    let state = this.states.get(chatJid);
    if (!state) {
      state = { chatJid, history: [] };
      this.states.set(chatJid, state);
    }
    return state;
  }

  private trimHistory(state: CoordinatorState): void {
    // Keep at most COORDINATOR_MAX_HISTORY turns (each turn = 1 user + 1 assistant)
    const maxMessages = COORDINATOR_MAX_HISTORY * 2;
    if (state.history.length > maxMessages) {
      state.history = state.history.slice(-maxMessages);
    }
  }

  private async handleToolCalls(
    chatJid: string,
    content: ContentBlock[],
  ): Promise<MessageParam> {
    const results: Anthropic.Messages.ToolResultBlockParam[] = [];

    for (const block of content) {
      if (block.type !== "tool_use") continue;
      const toolUse = block as ToolUseBlock;
      const input = toolUse.input as Record<string, string>;

      let result: string;
      try {
        result = await this.executeTool(chatJid, toolUse.name, input);
      } catch (err) {
        result = `Error: ${err instanceof Error ? err.message : String(err)}`;
        logger.error({ chatJid, tool: toolUse.name, err }, "Coordinator tool error");
      }

      results.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: result,
      });
    }

    return { role: "user", content: results };
  }

  private async executeTool(
    chatJid: string,
    toolName: string,
    input: Record<string, string>,
  ): Promise<string> {
    switch (toolName) {
      case "respond": {
        await this.deps.sendMessage(chatJid, input.text ?? "");
        return "Message sent.";
      }

      case "start_workspace": {
        const result = await this.deps.workspaceManager.startWorkspace(
          chatJid,
          input.name,
          input.prompt,
        );
        if (!result.ok) return `Failed to start workspace: ${result.error}`;
        return `Workspace "${input.name}" started.`;
      }

      case "send_to_workspace": {
        const sent = this.deps.workspaceManager.sendToWorkspace(chatJid, input.name, input.message);
        if (!sent) return `Workspace "${input.name}" is not running or not reachable.`;
        return `Message sent to workspace "${input.name}".`;
      }

      case "workspace_status": {
        const workspaces = this.deps.workspaceManager.getWorkspaces(chatJid);
        if (workspaces.length === 0) return "No active workspaces.";
        return workspaces
          .map(
            (w) =>
              `${w.name}: ${w.status} | started: ${w.startedAt}${w.lastActivity ? ` | last activity: ${w.lastActivity}` : ""}`,
          )
          .join("\n");
      }

      case "stop_workspace": {
        const stopped = this.deps.workspaceManager.stopWorkspace(chatJid, input.name);
        if (!stopped) return `Workspace "${input.name}" was not running.`;
        return `Workspace "${input.name}" stopped.`;
      }

      default:
        return `Unknown tool: ${toolName}`;
    }
  }

  async processMessage(chatJid: string, formattedMessages: string): Promise<void> {
    const state = this.getOrCreateState(chatJid);
    state.history.push({ role: "user", content: formattedMessages });
    this.trimHistory(state);

    await this.deps.setTyping?.(chatJid, true);

    try {
      await this.runLoop(chatJid, state);
    } finally {
      await this.deps.setTyping?.(chatJid, false);
    }
  }

  private async runLoop(chatJid: string, state: CoordinatorState): Promise<void> {
    for (let turn = 0; turn < 10; turn++) {
      let response: Anthropic.Messages.Message;
      try {
        response = await this.client.messages.create({
          model: COORDINATOR_MODEL,
          max_tokens: COORDINATOR_MAX_TOKENS,
          system: buildSystemPrompt(chatJid, this.deps.workspaceManager),
          messages: state.history,
          tools: COORDINATOR_TOOLS,
        });
      } catch (err) {
        logger.error({ chatJid, err }, "Coordinator API error");
        await this.deps.sendMessage(chatJid, "Sorry, I encountered an error processing your message.");
        return;
      }

      state.history.push({ role: "assistant", content: response.content });

      if (response.stop_reason === "end_turn") break;
      if (response.stop_reason !== "tool_use") break;

      const toolResultMsg = await this.handleToolCalls(chatJid, response.content);
      state.history.push(toolResultMsg);
    }
  }

  async handleWorkspaceProgress(
    chatJid: string,
    workspaceName: string,
    text: string,
  ): Promise<void> {
    const prefixed = `[${workspaceName}] ${text}`;
    await this.deps.sendMessage(chatJid, prefixed);
  }
}
