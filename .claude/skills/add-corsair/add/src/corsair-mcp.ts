import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import express from 'express';
import fs from 'fs';
import path from 'path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import { DATA_DIR, MAIN_GROUP_FOLDER } from './config.js';
import { getAllRegisteredGroups } from './db.js';
import { logger } from './logger.js';
import { corsair, db } from './corsair.js';

// ── IPC helpers (also used by corsair-webhooks.ts) ────────────────────────────

export function writeIpcTask(
	groupFolder: string,
	payload: Record<string, unknown>,
): void {
	const dir = path.join(DATA_DIR, 'ipc', groupFolder, 'tasks');
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(
		dir,
		`${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
	);
	fs.writeFileSync(file, JSON.stringify(payload));
}

export function writeIpcMessage(
	groupFolder: string,
	chatJid: string,
	text: string,
): void {
	const dir = path.join(DATA_DIR, 'ipc', groupFolder, 'messages');
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(
		dir,
		`${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
	);
	fs.writeFileSync(
		file,
		JSON.stringify({
			type: 'message',
			chatJid,
			text,
			groupFolder,
			timestamp: new Date().toISOString(),
		}),
	);
}

// ── Webhook listener storage ──────────────────────────────────────────────────

const LISTENERS_FILE = path.join(DATA_DIR, 'webhook-listeners.json');
const MAX_EVENT_CHARS = 8000;

export interface WebhookListener {
	id: string;
	plugin: string;
	action?: string; // undefined = match all actions for this plugin
	prompt: string;  // template: {{event}}, {{plugin}}, {{action}}
	chatJid: string;
	groupFolder: string;
	createdAt: string;
}

export function loadListeners(): WebhookListener[] {
	try {
		if (!fs.existsSync(LISTENERS_FILE)) return [];
		const raw = fs.readFileSync(LISTENERS_FILE, 'utf-8');
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function saveListeners(listeners: WebhookListener[]): void {
	const tmp = `${LISTENERS_FILE}.tmp`;
	fs.mkdirSync(path.dirname(LISTENERS_FILE), { recursive: true });
	fs.writeFileSync(tmp, JSON.stringify(listeners, null, 2));
	fs.renameSync(tmp, LISTENERS_FILE);
}

function renderPrompt(
	template: string,
	plugin: string,
	action: string,
	eventData: unknown,
): string {
	let eventStr: string;
	try {
		eventStr = JSON.stringify(eventData, null, 2);
	} catch {
		eventStr = String(eventData);
	}
	if (eventStr.length > MAX_EVENT_CHARS) {
		eventStr = eventStr.slice(0, MAX_EVENT_CHARS) + '\n... [truncated]';
	}
	return template
		.replace(/\{\{event\}\}/g, eventStr)
		.replace(/\{\{plugin\}\}/g, plugin)
		.replace(/\{\{action\}\}/g, action);
}

/**
 * Route a processed webhook event to any matching listeners.
 * Called after the HTTP response is sent — errors here don't affect the caller.
 */
export async function routeToListeners(
	plugin: string,
	action: string,
	eventData: unknown,
): Promise<void> {
	const listeners = loadListeners();
	const matches = listeners.filter(
		(l) =>
			l.plugin === plugin &&
			(l.action === undefined || l.action === '' || l.action === action),
	);

	for (const listener of matches) {
		try {
			const prompt = renderPrompt(listener.prompt, plugin, action, eventData);
			writeIpcTask(listener.groupFolder, {
				type: 'trigger_agent',
				chatJid: listener.chatJid,
				prompt,
			});
			logger.info(
				{ plugin, action, chatJid: listener.chatJid, listenerId: listener.id },
				'Webhook listener triggered',
			);
		} catch (err) {
			logger.error(
				{ err, listenerId: listener.id },
				'Failed to route webhook to listener',
			);
		}
	}
}

// ── Permission helpers ────────────────────────────────────────────────────────

type PendingPerm = {
	id: string;
	token: string;
	plugin: string;
	endpoint: string;
};

function getNewPendingPermissions(existingIds: Set<string>): PendingPerm[] {
	const rows = db
		.prepare(
			"SELECT id, token, plugin, endpoint FROM corsair_permissions WHERE status='pending'",
		)
		.all() as PendingPerm[];
	return rows.filter((r) => !existingIds.has(r.id));
}

// ── Permission poller (backup notifier for non-interactive contexts) ───────────

export function startPermissionPoller(intervalMs = 5000): void {
	const notified = new Set<string>();

	const poll = () => {
		const groups = getAllRegisteredGroups();
		const mainEntry = Object.entries(groups).find(
			([, g]) => g.folder === MAIN_GROUP_FOLDER,
		);
		if (!mainEntry) {
			setTimeout(poll, intervalMs);
			return;
		}
		const [mainJid, mainGroup] = mainEntry;

		const webhookUrl = process.env.WEBHOOK_URL || '';
		const pending = db
			.prepare(
				"SELECT id, token, plugin, endpoint, args, expires_at FROM corsair_permissions WHERE status='pending' AND expires_at > ?",
			)
			.all(new Date().toISOString()) as Array<
			PendingPerm & { args: string; expires_at: string }
		>;

		for (const perm of pending) {
			if (notified.has(perm.id)) continue;
			notified.add(perm.id);
			const approveUrl = `${webhookUrl}/api/permission/${perm.token}`;
			writeIpcMessage(
				mainGroup.folder,
				mainJid,
				[
					`⚠️ *Action needs approval*`,
					`Action: \`${perm.plugin}.${perm.endpoint}\``,
					``,
					`Approve: ${approveUrl}`,
					`To deny: reply to the agent and it will continue without this action.`,
					`Expires: ${new Date(perm.expires_at).toLocaleString()}`,
				].join('\n'),
			);
		}

		const activeIds = new Set(pending.map((p) => p.id));
		for (const id of [...notified]) {
			if (!activeIds.has(id)) notified.delete(id);
		}
		setTimeout(poll, intervalMs);
	};

	poll();
	logger.info('Corsair permission poller started');
}

// ── MCP tools ─────────────────────────────────────────────────────────────────

function buildMcpServer(): McpServer {
	const server = new McpServer({ name: 'corsair', version: '1.0.0' });

	server.registerTool(
		'list_operations',
		{
			description:
				'List available Corsair operations. type "api" = live API calls, "db" = cached entity queries, "webhook" = inbound event schemas.',
			inputSchema: {
				plugin: z
					.string()
					.optional()
					.describe('Plugin name (e.g. "slack"). Omit for all plugins.'),
				type: z.enum(['api', 'db', 'webhooks']).describe('Operation type'),
			},
			outputSchema: {},
		},
		async (args) => {
			const ops = corsair.list_operations({
				plugin: args.plugin,
				type: args.type,
			});
			return {
				content: [
					{ type: 'text' as const, text: JSON.stringify(ops, null, 2) },
				],
			};
		},
	);

	server.registerTool(
		'get_schema',
		{
			description:
				'Get the full input/output schema for a Corsair operation path (e.g. "slack.api.channels.list").',
			inputSchema: {
				path: z.string().describe('Full operation path from list_operations'),
			},
		},
		async (args) => {
			const schema = corsair.get_schema(args.path);

			return {
				content: [
					{ type: 'text' as const, text: JSON.stringify(schema, null, 2) },
				],
			};
		},
	);

	server.registerTool(
		'corsair_run',
		{
			description:
				'Execute TypeScript with corsair pre-imported. Code is type-checked before running — type errors are returned immediately without making any network calls. Use for API calls, mutations, and data fetching. console.log your results. Do not re-import corsair. If the action requires user approval, the approve URL is returned automatically — send it to the user.',
			inputSchema: {
				code: z
					.string()
					.describe('TypeScript code. `corsair` is already in scope.'),
			},
		},
		async (args) => {
			// Snapshot existing pending permission IDs before execution
			const existingIds = new Set(
				(
					db
						.prepare(
							"SELECT id FROM corsair_permissions WHERE status='pending'",
						)
						.all() as { id: string }[]
				).map((r) => r.id),
			);

			const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
			const tmp = path.join(process.cwd(), `_cr_${id}.ts`);
			fs.writeFileSync(
				tmp,
				`import { corsair } from './src/corsair.js';\n${args.code}`,
			);

			try {
				// Step 1: Type-check only — no network calls happen here
				const typeErrors = await new Promise<string | null>((resolve) => {
					const proc = spawn(
						'npx',
						[
							'tsc', '--noEmit',
							'--target', 'ES2022',
							'--module', 'NodeNext',
							'--moduleResolution', 'NodeNext',
							'--strict',
							'--esModuleInterop',
							'--skipLibCheck',
							tmp,
						],
						{ cwd: process.cwd() },
					);
					let output = '';
					proc.stdout.on('data', (d: Buffer) => { output += d; });
					proc.stderr.on('data', (d: Buffer) => { output += d; });
					proc.on('close', (code) => resolve(code !== 0 ? output : null));
				});

				if (typeErrors !== null) {
					// Strip the temp file path so errors reference clean line numbers
					const escaped = tmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
					const cleaned = typeErrors
						.replace(new RegExp(escaped, 'g'), 'code.ts')
						.trim();
					return {
						content: [{ type: 'text' as const, text: `Type error:\n${cleaned}` }],
						isError: true,
					};
				}

				// Step 2: Run
				let out = '';
				try {
					out = await new Promise<string>((resolve, reject) => {
						const proc = spawn('npx', ['tsx', tmp], { cwd: process.cwd() });
						let o = '', e = '';
						proc.stdout.on('data', (d: Buffer) => { o += d; });
						proc.stderr.on('data', (d: Buffer) => { e += d; });
						proc.on('error', (err) => reject(err));
						proc.on('close', (code) =>
							code !== 0
								? reject(new Error(e || `exit ${code}`))
								: resolve(o || e),
						);
					});
					logger.info({ output: out.slice(0, 2000) }, 'corsair_run output');
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					logger.error({ error: msg }, 'corsair_run error');
					return {
						content: [
							{
								type: 'text' as const,
								text: `Runtime error: ${msg}`,
							},
						],
						isError: true,
					};
				}

				// Detect any permissions created during this execution
				const webhookUrl = process.env.WEBHOOK_URL || '';
				const newPerms = getNewPendingPermissions(existingIds);
				if (newPerms.length > 0) {
					const permLines = newPerms
						.map(
							(p) =>
								`⚠️ Action blocked — approval needed\nAction: ${p.plugin}.${p.endpoint}\nApprove: ${webhookUrl}/api/permission/${p.token}\n\nShare this URL with the user so they can review and approve.`,
						)
						.join('\n\n');
					return {
						content: [
							{
								type: 'text' as const,
								text: [out, permLines].filter(Boolean).join('\n\n'),
							},
						],
					};
				}

				return { content: [{ type: 'text' as const, text: out }] };
			} finally {
				try { fs.unlinkSync(tmp); } catch { /* ignore */ }
			}
		},
	);

	server.registerTool(
		'list_pending_permissions',
		{
			description:
				'List all pending Corsair permission requests. Use this to check if the user has approved or if an action is still waiting.',
			inputSchema: {},
		},
		async () => {
			const rows = db
				.prepare(
					"SELECT id, plugin, endpoint, args, expires_at FROM corsair_permissions WHERE status='pending' AND expires_at > ?",
				)
				.all(new Date().toISOString());
			return {
				content: [
					{
						type: 'text' as const,
						text: rows.length
							? JSON.stringify(rows, null, 2)
							: 'No pending permissions.',
					},
				],
			};
		},
	);

	server.registerTool(
		'register_webhook_listener',
		{
			description:
				'Register a listener that triggers the agent when a Corsair webhook event arrives. Use list_operations with type "webhooks" to discover available plugins and actions. The prompt template supports {{event}} (full event JSON), {{plugin}}, and {{action}}.',
			inputSchema: {
				plugin: z
					.string()
					.describe('Plugin name to listen on (e.g. "slack", "github")'),
				action: z
					.string()
					.optional()
					.describe(
						'Specific action to match (e.g. "message_posted"). Omit to match all actions for this plugin.',
					),
				prompt: z
					.string()
					.describe(
						'Prompt template sent to the agent when the event fires. Use {{event}} for the event payload, {{plugin}}, {{action}} for metadata.',
					),
				chatJid: z
					.string()
					.describe(
						'JID of the registered group to notify. Use your current chat JID or another registered group.',
					),
			},
		},
		async (args) => {
			const groups = getAllRegisteredGroups();
			const entry = Object.entries(groups).find(
				([jid]) => jid === args.chatJid,
			);
			if (!entry) {
				return {
					content: [
						{
							type: 'text' as const,
							text: `No registered group found for JID "${args.chatJid}". Available JIDs:\n${Object.keys(groups).join('\n') || '(none)'}`,
						},
					],
					isError: true,
				};
			}
			const [, group] = entry;
			const listener: WebhookListener = {
				id: `whl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				plugin: args.plugin,
				action: args.action,
				prompt: args.prompt,
				chatJid: args.chatJid,
				groupFolder: group.folder,
				createdAt: new Date().toISOString(),
			};
			const listeners = loadListeners();
			listeners.push(listener);
			saveListeners(listeners);
			return {
				content: [
					{
						type: 'text' as const,
						text: `Listener registered (id: ${listener.id})\nPlugin: ${listener.plugin}${listener.action ? `\nAction: ${listener.action}` : ' (all actions)'}\nTarget: ${group.folder} (${args.chatJid})`,
					},
				],
			};
		},
	);

	server.registerTool(
		'list_webhook_listeners',
		{
			description: 'List all registered webhook listeners.',
			inputSchema: {},
		},
		async () => {
			const listeners = loadListeners();
			return {
				content: [
					{
						type: 'text' as const,
						text: listeners.length
							? JSON.stringify(listeners, null, 2)
							: 'No webhook listeners registered.',
					},
				],
			};
		},
	);

	server.registerTool(
		'remove_webhook_listener',
		{
			description:
				'Remove a webhook listener by ID. Use list_webhook_listeners to find IDs.',
			inputSchema: {
				id: z.string().describe('Listener ID to remove'),
			},
		},
		async (args) => {
			const listeners = loadListeners();
			const before = listeners.length;
			const filtered = listeners.filter((l) => l.id !== args.id);
			if (filtered.length === before) {
				return {
					content: [
						{
							type: 'text' as const,
							text: `No listener found with id "${args.id}".`,
						},
					],
					isError: true,
				};
			}
			saveListeners(filtered);
			return {
				content: [
					{ type: 'text' as const, text: `Listener ${args.id} removed.` },
				],
			};
		},
	);

	return server;
}

// ── Server entry point ────────────────────────────────────────────────────────

export function startCorsairMcpServer(port: number): void {
	startPermissionPoller();

	// Clean up any _cr_*.ts temp files left behind by a previous crash
	try {
		for (const f of fs.readdirSync(process.cwd())) {
			if (f.startsWith('_cr_') && f.endsWith('.ts')) {
				fs.unlinkSync(path.join(process.cwd(), f));
			}
		}
	} catch { /* ignore */ }

	const app = express();
	app.use(express.json());
	const transports = new Map<string, StreamableHTTPServerTransport>();

	const handleMcp = async (req: express.Request, res: express.Response) => {
		const sessionId = req.headers['mcp-session-id'] as string | undefined;

		if (sessionId) {
			const transport = transports.get(sessionId);
			if (!transport) {
				res.status(404).json({ error: 'Session not found' });
				return;
			}
			await transport.handleRequest(req, res, req.body);
			return;
		}

		// New session
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: () => randomUUID(),
		});
		transport.onclose = () => {
			if (transport.sessionId) transports.delete(transport.sessionId);
		};
		await buildMcpServer().connect(transport);
		await transport.handleRequest(req, res, req.body);
		// sessionId is populated after handleRequest processes the initialize request
		if (transport.sessionId) {
			transports.set(transport.sessionId, transport);
		}
	};

	app.all('/sse', handleMcp);
	app.all('/mcp', handleMcp);

	app.listen(port, () => logger.info(`Corsair MCP server on :${port}`));
}
