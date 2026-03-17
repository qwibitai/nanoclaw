GitHub Copilotの認証は、GitHub Device Flowを使用して実装されています [1](#0-0) 。

## 認証フローの概要

### 1. デバイスコードの取得
まずGitHubのデバイスコードエンドポイントにリクエストを送信し、ユーザーコードと検証URIを取得します [2](#0-1) 。

### 2. ユーザー認証
ユーザーは表示されたURLにアクセスし、ワンタイムコードを入力して認証を完了します [3](#0-2) 。

### 3. アクセストークンのポーリング
認証が完了すると、バックグラウンドでアクセストークンの取得をポーリングし続けます [4](#0-3) 。

### 4. Copilot APIトークンへの交換
取得したGitHubアクセストークンを使用して、Copilot APIトークンと交換します [5](#0-4) 。

## トークン管理

### キャッシュと自動更新
Copilotトークンはローカルにキャッシュされ、有効期限が近づくと自動的に更新されます [6](#0-5) 。

### 認証プロファイル
トークンは認証プロファイルとして保存され、複数のプロファイルを管理できます [7](#0-6) 。

## CLIコマンド

認証は以下のコマンドで実行できます：

```bash
openclaw models auth login-github-copilot
```

このコマンドは`githubCopilotLoginCommand`関数を実行します [8](#0-7) 。

## Notes

- 認証には対話的なTTYが必要です [9](#0-8) 
- Copilot Proxyプラグインを使用する代替手段もあります [10](#0-9) 
- トークン更新時のエラー処理も実装されています [11](#0-10)

### Citations

**File:** src/providers/github-copilot-auth.ts (L9-11)
```typescript
const CLIENT_ID = "Iv1.b507a08c87ecfe98";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
```

**File:** src/providers/github-copilot-auth.ts (L40-64)
```typescript
async function requestDeviceCode(params: { scope: string }): Promise<DeviceCodeResponse> {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    scope: params.scope,
  });

  const res = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`GitHub device code failed: HTTP ${res.status}`);
  }

  const json = parseJsonResponse<DeviceCodeResponse>(await res.json());
  if (!json.device_code || !json.user_code || !json.verification_uri) {
    throw new Error("GitHub device code response missing fields");
  }
  return json;
}
```

**File:** src/providers/github-copilot-auth.ts (L66-115)
```typescript
async function pollForAccessToken(params: {
  deviceCode: string;
  intervalMs: number;
  expiresAt: number;
}): Promise<string> {
  const bodyBase = new URLSearchParams({
    client_id: CLIENT_ID,
    device_code: params.deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });

  while (Date.now() < params.expiresAt) {
    const res = await fetch(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: bodyBase,
    });

    if (!res.ok) {
      throw new Error(`GitHub device token failed: HTTP ${res.status}`);
    }

    const json = parseJsonResponse<DeviceTokenResponse>(await res.json());
    if ("access_token" in json && typeof json.access_token === "string") {
      return json.access_token;
    }

    const err = "error" in json ? json.error : "unknown";
    if (err === "authorization_pending") {
      await new Promise((r) => setTimeout(r, params.intervalMs));
      continue;
    }
    if (err === "slow_down") {
      await new Promise((r) => setTimeout(r, params.intervalMs + 2000));
      continue;
    }
    if (err === "expired_token") {
      throw new Error("GitHub device code expired; run login again");
    }
    if (err === "access_denied") {
      throw new Error("GitHub login cancelled");
    }
    throw new Error(`GitHub device flow error: ${err}`);
  }

  throw new Error("GitHub device code expired; run login again");
}
```

**File:** src/providers/github-copilot-auth.ts (L121-123)
```typescript
  if (!process.stdin.isTTY) {
    throw new Error("github-copilot login requires an interactive TTY.");
  }
```

**File:** src/providers/github-copilot-auth.ts (L161-170)
```typescript
  upsertAuthProfile({
    profileId,
    credential: {
      type: "token",
      provider: "github-copilot",
      token: accessToken,
      // GitHub device flow token doesn't reliably include expiry here.
      // Leave expires unset; we'll exchange into Copilot token plus expiry later.
    },
  });
```

**File:** docs/providers/github-copilot.md (L25-30)
```markdown
### 2) Copilot Proxy plugin (`copilot-proxy`)

Use the **Copilot Proxy** VS Code extension as a local bridge. OpenClaw talks to
the proxy’s `/v1` endpoint and uses the model list you configure there. Choose
this when you already run Copilot Proxy in VS Code or need to route through it.
You must enable the plugin and keep the VS Code extension running.
```

**File:** docs/providers/github-copilot.md (L42-43)
```markdown
You'll be prompted to visit a URL and enter a one-time code. Keep the terminal
open until it completes.
```

**File:** src/providers/github-copilot-token.ts (L81-137)
```typescript
export async function resolveCopilotApiToken(params: {
  githubToken: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  cachePath?: string;
  loadJsonFileImpl?: (path: string) => unknown;
  saveJsonFileImpl?: (path: string, value: CachedCopilotToken) => void;
}): Promise<{
  token: string;
  expiresAt: number;
  source: string;
  baseUrl: string;
}> {
  const env = params.env ?? process.env;
  const cachePath = params.cachePath?.trim() || resolveCopilotTokenCachePath(env);
  const loadJsonFileFn = params.loadJsonFileImpl ?? loadJsonFile;
  const saveJsonFileFn = params.saveJsonFileImpl ?? saveJsonFile;
  const cached = loadJsonFileFn(cachePath) as CachedCopilotToken | undefined;
  if (cached && typeof cached.token === "string" && typeof cached.expiresAt === "number") {
    if (isTokenUsable(cached)) {
      return {
        token: cached.token,
        expiresAt: cached.expiresAt,
        source: `cache:${cachePath}`,
        baseUrl: deriveCopilotApiBaseUrlFromToken(cached.token) ?? DEFAULT_COPILOT_API_BASE_URL,
      };
    }
  }

  const fetchImpl = params.fetchImpl ?? fetch;
  const res = await fetchImpl(COPILOT_TOKEN_URL, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${params.githubToken}`,
    },
  });

  if (!res.ok) {
    throw new Error(`Copilot token exchange failed: HTTP ${res.status}`);
  }

  const json = parseCopilotTokenResponse(await res.json());
  const payload: CachedCopilotToken = {
    token: json.token,
    expiresAt: json.expiresAt,
    updatedAt: Date.now(),
  };
  saveJsonFileFn(cachePath, payload);

  return {
    token: payload.token,
    expiresAt: payload.expiresAt,
    source: `fetched:${COPILOT_TOKEN_URL}`,
    baseUrl: deriveCopilotApiBaseUrlFromToken(payload.token) ?? DEFAULT_COPILOT_API_BASE_URL,
  };
}
```

**File:** src/agents/pi-embedded-runner/run.ts (L465-498)
```typescript
      const refreshCopilotToken = async (reason: string): Promise<void> => {
        if (!copilotTokenState) {
          return;
        }
        if (copilotTokenState.refreshInFlight) {
          await copilotTokenState.refreshInFlight;
          return;
        }
        const { resolveCopilotApiToken } = await import("../../providers/github-copilot-token.js");
        copilotTokenState.refreshInFlight = (async () => {
          const githubToken = copilotTokenState.githubToken.trim();
          if (!githubToken) {
            throw new Error("Copilot refresh requires a GitHub token.");
          }
          log.debug(`Refreshing GitHub Copilot token (${reason})...`);
          const copilotToken = await resolveCopilotApiToken({
            githubToken,
          });
          authStorage.setRuntimeApiKey(model.provider, copilotToken.token);
          copilotTokenState.expiresAt = copilotToken.expiresAt;
          const remaining = copilotToken.expiresAt - Date.now();
          log.debug(
            `Copilot token refreshed; expires in ${Math.max(0, Math.floor(remaining / 1000))}s.`,
          );
        })()
          .catch((err) => {
            log.warn(`Copilot token refresh failed: ${describeUnknownError(err)}`);
            throw err;
          })
          .finally(() => {
            copilotTokenState.refreshInFlight = undefined;
          });
        await copilotTokenState.refreshInFlight;
      };
```

**File:** src/cli/models-cli.ts (L365-379)
```typescript
    .command("login-github-copilot")
    .description("Login to GitHub Copilot via GitHub device flow (TTY required)")
    .option("--profile-id <id>", "Auth profile id (default: github-copilot:github)")
    .option("--yes", "Overwrite existing profile without prompting", false)
    .action(async (opts) => {
      await runModelsCommand(async () => {
        await githubCopilotLoginCommand(
          {
            profileId: opts.profileId as string | undefined,
            yes: Boolean(opts.yes),
          },
          defaultRuntime,
        );
      });
    });
```

**File:** src/agents/pi-embedded-runner.run-embedded-pi-agent.auth-profile-rotation.e2e.test.ts (L492-559)
```typescript
describe("runEmbeddedPiAgent auth profile rotation", () => {
  it("refreshes copilot token after auth error and retries once", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-"));
    vi.useFakeTimers();
    try {
      await writeCopilotAuthStore(agentDir);
      const now = Date.now();
      vi.setSystemTime(now);

      resolveCopilotApiTokenMock
        .mockResolvedValueOnce({
          token: "copilot-initial",
          expiresAt: now + 2 * 60 * 1000,
          source: "mock",
          baseUrl: "https://api.copilot.example",
        })
        .mockResolvedValueOnce({
          token: "copilot-refresh",
          expiresAt: now + 60 * 60 * 1000,
          source: "mock",
          baseUrl: "https://api.copilot.example",
        });

      runEmbeddedAttemptMock
        .mockResolvedValueOnce(
          makeAttempt({
            assistantTexts: [],
            lastAssistant: buildCopilotAssistant({
              stopReason: "error",
              errorMessage: "unauthorized",
            }),
          }),
        )
        .mockResolvedValueOnce(
          makeAttempt({
            assistantTexts: ["ok"],
            lastAssistant: buildCopilotAssistant({
              stopReason: "stop",
              content: [{ type: "text", text: "ok" }],
            }),
          }),
        );

      await runEmbeddedPiAgent({
        sessionId: "session:test",
        sessionKey: "agent:test:copilot-auth-error",
        sessionFile: path.join(workspaceDir, "session.jsonl"),
        workspaceDir,
        agentDir,
        config: makeCopilotConfig(),
        prompt: "hello",
        provider: "github-copilot",
        model: copilotModelId,
        authProfileIdSource: "auto",
        timeoutMs: 5_000,
        runId: "run:copilot-auth-error",
      });

      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(2);
      expect(resolveCopilotApiTokenMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      await fs.rm(agentDir, { recursive: true, force: true });
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

```
