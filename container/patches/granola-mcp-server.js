#!/usr/bin/env node
/**
 * Granola MCP Server — plain JSON-RPC over stdio, no SDK dependency.
 * Env: GRANOLA_API_KEY (required, starts with grn_)
 */
const https = require("https");
const readline = require("readline");

const API_KEY = process.env.GRANOLA_API_KEY || "";
const BASE = "https://public-api.granola.ai/v1";

function apiGet(urlPath) {
  return new Promise((resolve, reject) => {
    const url = BASE + urlPath;
    https.get(url, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
        } else {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        }
      });
    }).on("error", reject);
  });
}

const TOOLS = [
  {
    name: "list_meetings",
    description: "List recent Granola meeting notes. Returns titles, dates, and IDs.",
    inputSchema: {
      type: "object",
      properties: {
        created_after: {
          type: "string",
          description: "ISO date to filter notes created after (e.g. 2026-03-01T00:00:00Z)"
        },
        cursor: {
          type: "string",
          description: "Pagination cursor from previous response"
        }
      }
    }
  },
  {
    name: "get_meeting_notes",
    description: "Get a specific meeting note by ID, including the AI-generated summary.",
    inputSchema: {
      type: "object",
      properties: {
        note_id: { type: "string", description: "The note/document ID" }
      },
      required: ["note_id"]
    }
  },
  {
    name: "get_meeting_transcript",
    description: "Get the full transcript for a specific meeting note.",
    inputSchema: {
      type: "object",
      properties: {
        note_id: { type: "string", description: "The note/document ID" }
      },
      required: ["note_id"]
    }
  }
];

async function handleTool(name, args) {
  if (!API_KEY) return "Error: GRANOLA_API_KEY not set";

  if (name === "list_meetings") {
    let url = "/notes";
    const params = [];
    if (args.created_after) params.push(`created_after=${encodeURIComponent(args.created_after)}`);
    if (args.cursor) params.push(`cursor=${encodeURIComponent(args.cursor)}`);
    if (params.length) url += "?" + params.join("&");

    const data = await apiGet(url);
    const notes = data.notes || data || [];
    if (Array.isArray(notes) && notes.length === 0) return "No meeting notes found.";

    const list = (Array.isArray(notes) ? notes : []).map((n, i) => {
      const date = n.created_at ? new Date(n.created_at).toLocaleString() : "?";
      return `${i + 1}. ${n.title || "(untitled)"} -- ${date}\n   ID: ${n.id}`;
    }).join("\n\n");

    let result = `Found ${notes.length} meeting notes:\n\n${list}`;
    if (data.next_cursor) result += `\n\nMore results available. Use cursor: ${data.next_cursor}`;
    return result;
  }

  if (name === "get_meeting_notes") {
    const data = await apiGet(`/notes/${args.note_id}`);
    const parts = [];
    parts.push(`Title: ${data.title || "(untitled)"}`);
    parts.push(`Created: ${data.created_at ? new Date(data.created_at).toLocaleString() : "?"}`);
    if (data.participants && data.participants.length) {
      parts.push(`Participants: ${data.participants.map(p => p.name || p.email || "?").join(", ")}`);
    }
    if (data.summary) parts.push(`\nSummary:\n${data.summary}`);
    if (data.content) parts.push(`\nNotes:\n${data.content}`);
    if (data.panels && data.panels.length) {
      for (const panel of data.panels) {
        parts.push(`\n[${panel.title || "Panel"}]:\n${panel.content || ""}`);
      }
    }
    return parts.join("\n");
  }

  if (name === "get_meeting_transcript") {
    const data = await apiGet(`/notes/${args.note_id}?include=transcript`);
    if (!data.transcript) return "No transcript available for this meeting.";

    const lines = Array.isArray(data.transcript)
      ? data.transcript.map(u => `[${u.speaker || "?"}]: ${u.text || ""}`).join("\n")
      : (typeof data.transcript === "string" ? data.transcript : JSON.stringify(data.transcript));

    return `Transcript for: ${data.title || "(untitled)"}\n\n${lines}`;
  }

  return `Unknown tool: ${name}`;
}

function send(obj) {
  const json = JSON.stringify(obj);
  process.stdout.write(json + "\n");
}

async function handleMessage(msg) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "granola", version: "1.0.0" }
      }
    });
    return;
  }

  if (method === "notifications/initialized") return;

  if (method === "tools/list") {
    send({
      jsonrpc: "2.0", id,
      result: { tools: TOOLS }
    });
    return;
  }

  if (method === "tools/call") {
    const { name, arguments: args } = params;
    try {
      const result = await handleTool(name, args || {});
      send({
        jsonrpc: "2.0", id,
        result: { content: [{ type: "text", text: result }] }
      });
    } catch (err) {
      send({
        jsonrpc: "2.0", id,
        result: { content: [{ type: "text", text: `Error: ${err.message}` }] }
      });
    }
    return;
  }

  send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` } });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    handleMessage(msg).catch(err => {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: err.message } });
    });
  } catch {}
});
