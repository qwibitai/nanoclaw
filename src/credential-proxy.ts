/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Docs map:
 * - docs/SECURITY.md#5-credential-isolation-credential-proxy
 * - docs/SPEC.md#claude-authentication
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 *
 * OAuth token sources (checked in order):
 *   1. .env CLAUDE_CODE_OAUTH_TOKEN (long-lived, from `claude setup-token`)
 *   2. ~/.claude/.credentials.json (short-lived, from `/login`)
 *      — auto-refreshed when expired/expiring via OAuth2 refresh_token grant
 */
import { execSync } from "child_process";
import fs from "fs";
import { createServer, Server } from "http";
import { request as httpsRequest } from "https";
import { request as httpRequest, RequestOptions } from "http";
import path from "path";

import { checkCircuit, recordAuthFailure } from "./auth-circuit-breaker.js";
import { readEnvFile } from "./env.js";
import { logger } from "./logger.js";

export type AuthMode = "api-key" | "oauth";

/**
 * Refresh an OAuth token using the standard OAuth2 refresh_token grant.
 * Updates the credentials file on success so other processes benefit.
 */
function refreshOAuthToken(
  refreshToken: string,
  credentialsPath: string,
  creds: Record<string, any>,
): string | null {
  try {
    const result = execSync(
      `curl -s -X POST https://platform.claude.com/v1/oauth/token ` +
        `-H "Content-Type: application/x-www-form-urlencoded" ` +
        `--data-urlencode @-`,
      {
        input: `grant_type=refresh_token&refresh_token=${refreshToken}`,
        timeout: 10_000,
        encoding: "utf-8",
      },
    );
    const data = JSON.parse(result);
    if (data.access_token) {
      creds.claudeAiOauth.accessToken = data.access_token;
      if (data.expires_in) {
        creds.claudeAiOauth.expiresAt = Date.now() + data.expires_in * 1000;
      }
      if (data.refresh_token) {
        creds.claudeAiOauth.refreshToken = data.refresh_token;
      }
      fs.writeFileSync(credentialsPath, JSON.stringify(creds, null, 2), { mode: 0o600 });
      logger.info("OAuth token refreshed successfully");
      return data.access_token;
    }
    logger.error({ response: data }, "OAuth refresh: no access_token in response");
  } catch (err) {
    logger.error({ error: err }, "OAuth token refresh failed");
  }
  return null;
}

/**
 * Resolve the current OAuth token for proxy injection.
 * Checks circuit breaker, prefers .env token, falls back to credentials file
 * with auto-refresh for expired tokens.
 */
function resolveOAuthToken(envToken: string | undefined): string | undefined {
  const circuit = checkCircuit();
  if (!circuit.allowed) {
    logger.warn(circuit.reason, "Circuit breaker blocked credential read");
    return envToken; // fall back to whatever we have
  }

  // Prefer .env CLAUDE_CODE_OAUTH_TOKEN (long-lived setup-token)
  if (envToken) return envToken;

  // Fall back to credentials file (short-lived /login token)
  const credentialsPath = path.join(
    process.env.HOME || "/home/node",
    ".claude",
    ".credentials.json",
  );
  try {
    const creds = JSON.parse(fs.readFileSync(credentialsPath, "utf-8"));
    const oauth = creds.claudeAiOauth;
    if (oauth?.accessToken) {
      const expiresAt = oauth.expiresAt || 0;
      const isExpired = Date.now() > expiresAt - 5 * 60 * 1000;

      if (isExpired && oauth.refreshToken) {
        const refreshed = refreshOAuthToken(oauth.refreshToken, credentialsPath, creds);
        if (!refreshed) {
          recordAuthFailure();
        }
        return refreshed || oauth.accessToken;
      }
      return oauth.accessToken;
    }
  } catch {
    logger.warn("No OAuth token available: .env empty and credentials file unreadable");
  }

  return undefined;
}

export function startCredentialProxy(port: number, host = "127.0.0.1"): Promise<Server> {
  const secrets = readEnvFile([
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? "api-key" : "oauth";
  const envOAuthToken = secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(secrets.ANTHROPIC_BASE_URL || "https://api.anthropic.com");
  const isHttps = upstreamUrl.protocol === "https:";
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> = {
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
          // OAuth mode: resolve token on each request (handles refresh + credentials.json fallback)
          if (headers["authorization"]) {
            delete headers["authorization"];
            const token = resolveOAuthToken(envOAuthToken);
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
          logger.error({ err, url: req.url }, "Credential proxy upstream error");
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

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(["ANTHROPIC_API_KEY"]);
  return secrets.ANTHROPIC_API_KEY ? "api-key" : "oauth";
}
