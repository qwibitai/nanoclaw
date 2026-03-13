/**
 * Tanren MCP Server for NanoClaw
 * Standalone stdio MCP server exposing tanren API tools to container agents.
 * Only started for main group containers with tanren config.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const apiUrl = process.env.TANREN_API_URL;
const apiKey = process.env.TANREN_API_KEY;

if (!apiUrl || !apiKey) {
  console.error("[tanren-mcp] Missing TANREN_API_URL or TANREN_API_KEY");
  process.exit(1);
}

async function tanrenFetch(method: string, path: string, body?: unknown) {
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      "x-api-key": apiKey!,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) {
    throw new Error(
      `Tanren API ${res.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`,
    );
  }
  return data;
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function err(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

const server = new McpServer({
  name: "tanren",
  version: "1.0.0",
});

// --- Health ---
server.tool("tanren_health", "Check tanren API health status.", {}, async () => {
  try {
    return ok(await tanrenFetch("GET", "/api/v1/health"));
  } catch (e) {
    return err(e);
  }
});

// --- Dispatch ---
server.tool(
  "tanren_dispatch",
  "Create a new dispatch (send work to tanren for execution on a VM). Returns a dispatch ID for tracking.",
  {
    project: z.string().describe("GitHub project (owner/repo)"),
    phase: z.string().describe("Phase to execute (e.g. 'do-task', 'audit')"),
    branch: z.string().describe("Git branch to work on"),
    spec_folder: z.string().describe("Path to spec folder in the repo"),
    cli: z.string().describe("CLI tool to use (e.g. 'claude', 'codex')"),
    model: z.string().optional().describe("Model override"),
    timeout: z.number().optional().describe("Timeout in seconds"),
    environment_profile: z.string().optional().describe("VM environment profile"),
    context: z.string().optional().describe("Additional context for the agent"),
    gate_cmd: z.string().optional().describe("Gate command to run after execution"),
  },
  async (args) => {
    try {
      return ok(await tanrenFetch("POST", "/api/v1/dispatch", args));
    } catch (e) {
      return err(e);
    }
  },
);

server.tool(
  "tanren_dispatch_status",
  "Get the status of a dispatch by ID.",
  {
    id: z.string().describe("Dispatch/workflow ID"),
  },
  async (args) => {
    try {
      return ok(await tanrenFetch("GET", `/api/v1/dispatch/${encodeURIComponent(args.id)}`));
    } catch (e) {
      return err(e);
    }
  },
);

server.tool(
  "tanren_cancel",
  "Cancel a running dispatch.",
  {
    id: z.string().describe("Dispatch/workflow ID to cancel"),
  },
  async (args) => {
    try {
      return ok(await tanrenFetch("DELETE", `/api/v1/dispatch/${encodeURIComponent(args.id)}`));
    } catch (e) {
      return err(e);
    }
  },
);

// --- Run lifecycle ---
server.tool(
  "tanren_provision",
  "Provision a VM environment for a project. Returns an env_id for subsequent execute/teardown.",
  {
    project: z.string().describe("GitHub project (owner/repo)"),
    branch: z.string().describe("Git branch"),
    environment_profile: z.string().optional().describe("VM environment profile"),
  },
  async (args) => {
    try {
      return ok(await tanrenFetch("POST", "/api/v1/run/provision", args));
    } catch (e) {
      return err(e);
    }
  },
);

server.tool(
  "tanren_execute",
  "Execute the agent phase on a provisioned environment.",
  {
    env_id: z.string().describe("Environment ID from provision"),
  },
  async (args) => {
    try {
      return ok(
        await tanrenFetch("POST", `/api/v1/run/${encodeURIComponent(args.env_id)}/execute`),
      );
    } catch (e) {
      return err(e);
    }
  },
);

server.tool(
  "tanren_teardown",
  "Tear down a provisioned environment and release its VM.",
  {
    env_id: z.string().describe("Environment ID to tear down"),
  },
  async (args) => {
    try {
      return ok(
        await tanrenFetch("POST", `/api/v1/run/${encodeURIComponent(args.env_id)}/teardown`),
      );
    } catch (e) {
      return err(e);
    }
  },
);

server.tool(
  "tanren_run_full",
  "Run a full lifecycle (provision → execute → teardown) in one call. Returns a dispatch ID.",
  {
    project: z.string().describe("GitHub project (owner/repo)"),
    branch: z.string().describe("Git branch"),
    spec_path: z.string().describe("Path to spec file"),
    phase: z.string().describe("Phase to execute"),
    environment_profile: z.string().optional().describe("VM environment profile"),
    timeout: z.number().optional().describe("Timeout in seconds"),
    context: z.string().optional().describe("Additional context"),
    gate_cmd: z.string().optional().describe("Gate command"),
  },
  async (args) => {
    try {
      return ok(await tanrenFetch("POST", "/api/v1/run/full", args));
    } catch (e) {
      return err(e);
    }
  },
);

server.tool(
  "tanren_run_status",
  "Get the status of a running environment.",
  {
    env_id: z.string().describe("Environment ID"),
  },
  async (args) => {
    try {
      return ok(await tanrenFetch("GET", `/api/v1/run/${encodeURIComponent(args.env_id)}/status`));
    } catch (e) {
      return err(e);
    }
  },
);

// --- VM management ---
server.tool("tanren_vm_list", "List all active VMs.", {}, async () => {
  try {
    return ok(await tanrenFetch("GET", "/api/v1/vm"));
  } catch (e) {
    return err(e);
  }
});

server.tool(
  "tanren_vm_release",
  "Release (destroy) a specific VM.",
  {
    vm_id: z.string().describe("VM ID to release"),
  },
  async (args) => {
    try {
      return ok(await tanrenFetch("DELETE", `/api/v1/vm/${encodeURIComponent(args.vm_id)}`));
    } catch (e) {
      return err(e);
    }
  },
);

// --- Config ---
server.tool("tanren_config", "Get tanren server configuration.", {}, async () => {
  try {
    return ok(await tanrenFetch("GET", "/api/v1/config"));
  } catch (e) {
    return err(e);
  }
});

// --- Events ---
server.tool(
  "tanren_events",
  "Query tanren event log. Filter by workflow ID, event type, with pagination.",
  {
    workflow_id: z.string().optional().describe("Filter by workflow/dispatch ID"),
    event_type: z.string().optional().describe("Filter by event type"),
    limit: z.number().optional().describe("Max events to return"),
    offset: z.number().optional().describe("Pagination offset"),
  },
  async (args) => {
    try {
      const params = new URLSearchParams();
      if (args.workflow_id) params.set("workflow_id", args.workflow_id);
      if (args.event_type) params.set("event_type", args.event_type);
      if (args.limit != null) params.set("limit", String(args.limit));
      if (args.offset != null) params.set("offset", String(args.offset));
      const qs = params.toString();
      const path = `/api/v1/events${qs ? `?${qs}` : ""}`;
      return ok(await tanrenFetch("GET", path));
    } catch (e) {
      return err(e);
    }
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
