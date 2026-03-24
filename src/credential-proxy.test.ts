import http from "http";
import type { AddressInfo } from "net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockEnv: Record<string, string> = {};
vi.mock("./env.js", () => ({
	readEnvFile: vi.fn(() => ({ ...mockEnv })),
}));

// Prevent tests from reading the real ~/.claude/.credentials.json
vi.mock("fs", async () => {
	const actual = await vi.importActual<typeof import("fs")>("fs");
	return {
		...actual,
		default: {
			...actual,
			readFileSync: vi.fn((filePath: string, ...args: unknown[]) => {
				if (String(filePath).includes(".credentials.json")) {
					throw new Error("mocked: file not found");
				}
				return actual.readFileSync(filePath, ...(args as [BufferEncoding]));
			}),
		},
	};
});

vi.mock("./logger.js", () => ({
	logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import {
	startCredentialProxy,
	startUserCredentialProxy,
} from "./credential-proxy.js";

function makeRequest(
	port: number,
	options: http.RequestOptions,
	body = "",
): Promise<{
	statusCode: number;
	body: string;
	headers: http.IncomingHttpHeaders;
}> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ ...options, hostname: "127.0.0.1", port },
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () => {
					resolve({
						statusCode: res.statusCode!,
						body: Buffer.concat(chunks).toString(),
						headers: res.headers,
					});
				});
			},
		);
		req.on("error", reject);
		req.write(body);
		req.end();
	});
}

describe("credential-proxy", () => {
	let proxyServer: http.Server;
	let upstreamServer: http.Server;
	let proxyPort: number;
	let upstreamPort: number;
	let lastUpstreamHeaders: http.IncomingHttpHeaders;

	beforeEach(async () => {
		lastUpstreamHeaders = {};

		upstreamServer = http.createServer((req, res) => {
			lastUpstreamHeaders = { ...req.headers };
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		});
		await new Promise<void>((resolve) =>
			upstreamServer.listen(0, "127.0.0.1", resolve),
		);
		upstreamPort = (upstreamServer.address() as AddressInfo).port;
	});

	afterEach(async () => {
		await new Promise<void>((r) => proxyServer?.close(() => r()));
		await new Promise<void>((r) => upstreamServer?.close(() => r()));
		for (const key of Object.keys(mockEnv)) delete mockEnv[key];
	});

	async function startProxy(env: Record<string, string>): Promise<number> {
		Object.assign(mockEnv, env, {
			ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
		});
		proxyServer = await startCredentialProxy(0);
		return (proxyServer.address() as AddressInfo).port;
	}

	it("API-key mode injects x-api-key and strips placeholder", async () => {
		proxyPort = await startProxy({ ANTHROPIC_API_KEY: "sk-ant-real-key" });

		await makeRequest(
			proxyPort,
			{
				method: "POST",
				path: "/v1/messages",
				headers: {
					"content-type": "application/json",
					"x-api-key": "placeholder",
				},
			},
			"{}",
		);

		expect(lastUpstreamHeaders["x-api-key"]).toBe("sk-ant-real-key");
	});

	it("OAuth mode replaces Authorization when container sends one", async () => {
		proxyPort = await startProxy({
			CLAUDE_CODE_OAUTH_TOKEN: "real-oauth-token",
		});

		await makeRequest(
			proxyPort,
			{
				method: "POST",
				path: "/api/oauth/claude_cli/create_api_key",
				headers: {
					"content-type": "application/json",
					authorization: "Bearer placeholder",
				},
			},
			"{}",
		);

		expect(lastUpstreamHeaders["authorization"]).toBe(
			"Bearer real-oauth-token",
		);
	});

	it("OAuth mode does not inject Authorization when container omits it", async () => {
		proxyPort = await startProxy({
			CLAUDE_CODE_OAUTH_TOKEN: "real-oauth-token",
		});

		// Post-exchange: container uses x-api-key only, no Authorization header
		await makeRequest(
			proxyPort,
			{
				method: "POST",
				path: "/v1/messages",
				headers: {
					"content-type": "application/json",
					"x-api-key": "temp-key-from-exchange",
				},
			},
			"{}",
		);

		expect(lastUpstreamHeaders["x-api-key"]).toBe("temp-key-from-exchange");
		expect(lastUpstreamHeaders["authorization"]).toBeUndefined();
	});

	it("strips hop-by-hop headers", async () => {
		proxyPort = await startProxy({ ANTHROPIC_API_KEY: "sk-ant-real-key" });

		await makeRequest(
			proxyPort,
			{
				method: "POST",
				path: "/v1/messages",
				headers: {
					"content-type": "application/json",
					connection: "keep-alive",
					"keep-alive": "timeout=5",
					"transfer-encoding": "chunked",
				},
			},
			"{}",
		);

		// Proxy strips client hop-by-hop headers. Node's HTTP client may re-add
		// its own Connection header (standard HTTP/1.1 behavior), but the client's
		// custom keep-alive and transfer-encoding must not be forwarded.
		expect(lastUpstreamHeaders["keep-alive"]).toBeUndefined();
		expect(lastUpstreamHeaders["transfer-encoding"]).toBeUndefined();
	});

	it("returns 502 when upstream is unreachable", async () => {
		Object.assign(mockEnv, {
			ANTHROPIC_API_KEY: "sk-ant-real-key",
			ANTHROPIC_BASE_URL: "http://127.0.0.1:59999",
		});
		proxyServer = await startCredentialProxy(0);
		proxyPort = (proxyServer.address() as AddressInfo).port;

		const res = await makeRequest(
			proxyPort,
			{
				method: "POST",
				path: "/v1/messages",
				headers: { "content-type": "application/json" },
			},
			"{}",
		);

		expect(res.statusCode).toBe(502);
		expect(res.body).toBe("Bad Gateway");
	});

	describe("per-user credential proxy", () => {
		let userProxyServer: http.Server;
		let userUpstreamServer: http.Server;

		afterEach(async () => {
			await new Promise<void>((r) => userProxyServer?.close(() => r()));
			await new Promise<void>((r) => userUpstreamServer?.close(() => r()));
		});

		it("reads OAuth token from the specified home directory", async () => {
			// Override the fs mock to return a token for a specific path
			const fsModule = await import("fs");
			const spy = vi
				.spyOn(fsModule.default, "readFileSync")
				.mockImplementation((filePath: any, ...args: any[]) => {
					if (String(filePath) === "/home/testuser/.claude/.credentials.json") {
						return JSON.stringify({
							claudeAiOauth: { accessToken: "user-specific-token" },
						});
					}
					if (String(filePath).includes(".credentials.json")) {
						throw new Error("mocked: file not found");
					}
					// For non-credentials files, we need the real readFileSync
					// The test infrastructure needs real fs for module loading
					throw new Error("unexpected read");
				});

			let capturedHeaders: http.IncomingHttpHeaders = {};
			userUpstreamServer = http.createServer((req, res) => {
				capturedHeaders = { ...req.headers };
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
			});
			await new Promise<void>((r) =>
				userUpstreamServer.listen(0, "127.0.0.1", r),
			);
			const userUpstreamPort = (userUpstreamServer.address() as AddressInfo)
				.port;

			userProxyServer = await startUserCredentialProxy(
				"/home/testuser",
				0,
				`http://127.0.0.1:${userUpstreamPort}`,
			);
			const userProxyPort = (userProxyServer.address() as AddressInfo).port;

			await makeRequest(
				userProxyPort,
				{
					method: "POST",
					path: "/api/oauth/claude_cli/create_api_key",
					headers: {
						"content-type": "application/json",
						authorization: "Bearer placeholder",
					},
				},
				"{}",
			);

			expect(capturedHeaders["authorization"]).toBe(
				"Bearer user-specific-token",
			);

			spy.mockRestore();
		});
	});
});
