/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 *
 * OAuth token resolution (in priority order):
 *   1. ~/.claude/.credentials.json — auto-refreshed by Claude Code
 *   2. CLAUDE_CODE_OAUTH_TOKEN in .env — static fallback
 *   3. ANTHROPIC_AUTH_TOKEN in .env — legacy fallback
 */
import fs from "fs";
import {
	createServer,
	request as httpRequest,
	type RequestOptions,
	type Server,
} from "http";
import { request as httpsRequest } from "https";
import type { AddressInfo } from "net";
import os from "os";
import path from "path";

import { readEnvFile } from "./env.js";
import { logger } from "./logger.js";

export type AuthMode = "api-key" | "oauth";

export interface ProxyConfig {
	authMode: AuthMode;
}

/**
 * Read the current OAuth access token from ~/.claude/.credentials.json.
 * Returns undefined if the file doesn't exist or can't be parsed.
 * Called on each request so the proxy always uses the freshest token.
 */
function readCredentialsToken(): string | undefined {
	try {
		const credsPath = path.join(os.homedir(), ".claude", ".credentials.json");
		const raw = fs.readFileSync(credsPath, "utf-8");
		const creds = JSON.parse(raw);
		return creds?.claudeAiOauth?.accessToken;
	} catch {
		return undefined;
	}
}

export function startCredentialProxy(
	port: number,
	host = "127.0.0.1",
): Promise<Server> {
	const secrets = readEnvFile([
		"ANTHROPIC_API_KEY",
		"CLAUDE_CODE_OAUTH_TOKEN",
		"ANTHROPIC_AUTH_TOKEN",
		"ANTHROPIC_BASE_URL",
	]);

	const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? "api-key" : "oauth";
	const envOauthToken =
		secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

	const upstreamUrl = new URL(
		secrets.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
	);
	const isHttps = upstreamUrl.protocol === "https:";
	const makeRequest = isHttps ? httpsRequest : httpRequest;

	return new Promise((resolve, reject) => {
		const server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (c) => chunks.push(c));
			req.on("end", () => {
				const body = Buffer.concat(chunks);
				const headers: Record<string, string | number | string[] | undefined> =
					{
						...(req.headers as Record<string, string>),
						host: upstreamUrl.host,
						"content-length": body.length,
					};

				// Strip hop-by-hop headers that must not be forwarded by proxies
				delete headers["connection"];
				delete headers["keep-alive"];
				delete headers["transfer-encoding"];

				if (authMode === "api-key") {
					// API key mode: inject x-api-key on every request
					delete headers["x-api-key"];
					headers["x-api-key"] = secrets.ANTHROPIC_API_KEY;
				} else {
					// OAuth mode: replace placeholder Bearer token with the real one
					// only when the container actually sends an Authorization header
					// (exchange request + auth probes). Post-exchange requests use
					// x-api-key only, so they pass through without token injection.
					if (headers["authorization"]) {
						delete headers["authorization"];
						// Read fresh token on each request: credentials.json first
						// (auto-refreshed by Claude Code), then .env as fallback.
						const token = readCredentialsToken() || envOauthToken;
						if (token) {
							headers["authorization"] = `Bearer ${token}`;
						}
					}
				}

				const upstream = makeRequest(
					{
						hostname: upstreamUrl.hostname,
						port: upstreamUrl.port || (isHttps ? 443 : 80),
						path: req.url,
						method: req.method,
						headers,
					} as RequestOptions,
					(upRes) => {
						res.writeHead(upRes.statusCode!, upRes.headers);
						upRes.pipe(res);
					},
				);

				upstream.on("error", (err) => {
					logger.error(
						{ err, url: req.url },
						"Credential proxy upstream error",
					);
					if (!res.headersSent) {
						res.writeHead(502);
						res.end("Bad Gateway");
					}
				});

				upstream.write(body);
				upstream.end();
			});
		});

		server.listen(port, host, () => {
			logger.info({ port, host, authMode }, "Credential proxy started");
			resolve(server);
		});

		server.on("error", reject);
	});
}

/**
 * Read OAuth token from a specific user's home directory.
 * Called fresh on every request to always use the latest token.
 */
function readUserCredentialsToken(homeDir: string): string | undefined {
	try {
		const credsPath = path.join(homeDir, ".claude", ".credentials.json");
		const raw = fs.readFileSync(credsPath, "utf-8");
		const creds = JSON.parse(raw);
		return creds?.claudeAiOauth?.accessToken;
	} catch {
		return undefined;
	}
}

/**
 * Start a per-user credential proxy on an ephemeral port.
 * Uses the specified user's OAuth token from their home directory.
 * Always reads the token fresh on each request (never cached).
 *
 * @param homeDir - User's home directory (e.g., /home/alice)
 * @param port - Port to listen on (0 for ephemeral)
 * @param upstreamBaseUrl - Upstream API URL (optional, defaults to https://api.anthropic.com)
 * @returns Server instance — caller is responsible for closing on container exit
 */
export function startUserCredentialProxy(
	homeDir: string,
	port: number = 0,
	upstreamBaseUrl?: string,
): Promise<Server> {
	const upstreamUrl = new URL(upstreamBaseUrl || "https://api.anthropic.com");
	const isHttps = upstreamUrl.protocol === "https:";
	const makeUpstreamRequest = isHttps ? httpsRequest : httpRequest;

	return new Promise((resolve, reject) => {
		const server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (c) => chunks.push(c));
			req.on("end", () => {
				const body = Buffer.concat(chunks);
				const headers: Record<string, string | number | string[] | undefined> =
					{
						...(req.headers as Record<string, string>),
						host: upstreamUrl.host,
						"content-length": body.length,
					};

				delete headers["connection"];
				delete headers["keep-alive"];
				delete headers["transfer-encoding"];

				// OAuth mode only — per-user proxy always uses OAuth (Claude Max)
				if (headers["authorization"]) {
					delete headers["authorization"];
					const token = readUserCredentialsToken(homeDir);
					if (token) {
						headers["authorization"] = `Bearer ${token}`;
					} else {
						logger.warn(
							{ homeDir },
							"No valid OAuth token found for user — request will likely fail with 401",
						);
					}
				}

				const upstream = makeUpstreamRequest(
					{
						hostname: upstreamUrl.hostname,
						port: upstreamUrl.port || (isHttps ? 443 : 80),
						path: req.url,
						method: req.method,
						headers,
					} as RequestOptions,
					(upRes) => {
						res.writeHead(upRes.statusCode!, upRes.headers);
						upRes.pipe(res);
					},
				);

				upstream.on("error", (err) => {
					logger.error(
						{ err, url: req.url, homeDir },
						"User credential proxy upstream error",
					);
					if (!res.headersSent) {
						res.writeHead(502);
						res.end("Bad Gateway");
					}
				});

				upstream.write(body);
				upstream.end();
			});
		});

		server.listen(port, "127.0.0.1", () => {
			const addr = server.address() as AddressInfo;
			logger.info(
				{ port: addr.port, homeDir },
				"Per-user credential proxy started",
			);
			resolve(server);
		});

		server.on("error", reject);
	});
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
	const secrets = readEnvFile(["ANTHROPIC_API_KEY"]);
	return secrets.ANTHROPIC_API_KEY ? "api-key" : "oauth";
}
