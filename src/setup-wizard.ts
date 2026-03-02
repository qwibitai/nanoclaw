/**
 * Setup Wizard — interactive web-based first-run configuration.
 * Serves a single-page app at /setup with a 6-step guided flow.
 * All routes are localhost-only and disabled after setup completes.
 */
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';

import { STORE_DIR, GROUPS_DIR } from './config.js';
import { writeEnvFile } from './env.js';
import { logger } from './logger.js';
import {
  isWizardComplete,
  markStepComplete,
  readWizardState,
  writeWizardState,
  type WizardState,
} from './wizard-state.js';

// ── Body Parser ─────────────────────────────────────────────────────

const MAX_BODY = 64 * 1024; // 64KB

function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error('Body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// ── Localhost Guard ─────────────────────────────────────────────────

function isLocalhost(req: http.IncomingMessage): boolean {
  const addr = req.socket.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

// ── Build Job Manager ───────────────────────────────────────────────

interface BuildPhase {
  name: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  startedAt?: number;
  completedAt?: number;
}

interface BuildJob {
  status: 'idle' | 'running' | 'done' | 'failed';
  currentPhase: number;
  phases: BuildPhase[];
  rawLog: string[];
  error?: string;
}

const buildJob: BuildJob = {
  status: 'idle',
  currentPhase: -1,
  phases: [],
  rawLog: [],
};

// SSE clients waiting for build updates
const sseClients: Set<http.ServerResponse> = new Set();

function broadcastBuildUpdate(): void {
  const data = JSON.stringify({
    status: buildJob.status,
    currentPhase: buildJob.currentPhase,
    phases: buildJob.phases,
    error: buildJob.error,
  });
  for (const client of sseClients) {
    client.write(`data: ${data}\n\n`);
  }
}

function runBuildPhase(
  command: string,
  args: string[],
  cwd: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc: ChildProcess = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout?.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n').filter(Boolean);
      buildJob.rawLog.push(...lines);
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n').filter(Boolean);
      buildJob.rawLog.push(...lines);
    });

    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Process exited with code ${code}`));
    });

    proc.on('error', reject);
  });
}

async function startBuild(agentName: string): Promise<void> {
  if (buildJob.status === 'running') return;

  const projectRoot = process.cwd();
  buildJob.status = 'running';
  buildJob.currentPhase = 0;
  buildJob.rawLog = [];
  buildJob.error = undefined;
  buildJob.phases = [
    { name: 'validate', label: 'Validating configuration...', status: 'pending' },
    { name: 'compile', label: `Compiling ${agentName}'s brain...`, status: 'pending' },
    { name: 'container', label: `Building ${agentName}'s home...`, status: 'pending' },
    { name: 'start', label: `Starting ${agentName}...`, status: 'pending' },
  ];

  const phaseCommands = [
    { cmd: 'node', args: ['-e', 'process.exit(0)'], cwd: projectRoot },
    { cmd: 'npm', args: ['run', 'build'], cwd: projectRoot },
    { cmd: 'bash', args: ['./container/build.sh'], cwd: projectRoot },
    { cmd: 'echo', args: ['Service ready'], cwd: projectRoot },
  ];

  broadcastBuildUpdate();

  for (let i = 0; i < phaseCommands.length; i++) {
    buildJob.currentPhase = i;
    buildJob.phases[i].status = 'running';
    buildJob.phases[i].startedAt = Date.now();
    broadcastBuildUpdate();

    try {
      const { cmd, args, cwd } = phaseCommands[i];
      await runBuildPhase(cmd, args, cwd);
      buildJob.phases[i].status = 'done';
      buildJob.phases[i].completedAt = Date.now();
      broadcastBuildUpdate();
    } catch (err) {
      buildJob.phases[i].status = 'failed';
      buildJob.phases[i].completedAt = Date.now();
      buildJob.status = 'failed';
      const rawErr = err instanceof Error ? err.message : 'Build phase failed';
      const phase = buildJob.phases[i];
      if (phase.name === 'validate' && rawErr.includes('code 2')) {
        buildJob.error = "Couldn't connect to Docker. Is Docker Desktop running? Look for the whale icon in your taskbar.";
      } else if (phase.name === 'compile') {
        buildJob.error = "Something went wrong compiling. Click 'Show Details' for the technical log, or try again.";
      } else if (phase.name === 'container' && rawErr.includes('code')) {
        buildJob.error = "Docker build failed. Make sure Docker Desktop is running and has enough disk space.";
      } else {
        buildJob.error = rawErr;
      }
      broadcastBuildUpdate();
      return;
    }
  }

  buildJob.status = 'done';
  broadcastBuildUpdate();
}

// ── API Key Validation ──────────────────────────────────────────────

async function validateAnthropicKey(key: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    if (res.ok || res.status === 200) return { ok: true };
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) {
      return { ok: false, error: "This API key wasn't recognized. Double-check you copied the full key from console.anthropic.com" };
    }
    if (res.status === 403) {
      return { ok: false, error: "This key doesn't have permission to use the API. Check your Anthropic account settings." };
    }
    return { ok: false, error: (body as Record<string, unknown>).error?.toString() || `Validation failed (status ${res.status})` };
  } catch {
    return { ok: false, error: "Couldn't reach Anthropic's API. Check your internet connection." };
  }
}

async function validateOpenRouterKey(key: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/auth/key', {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.ok) return { ok: true };
    if (res.status === 401) {
      return { ok: false, error: "This OpenRouter key wasn't recognized. Copy it from openrouter.ai/settings/keys" };
    }
    return { ok: false, error: `OpenRouter validation failed (status ${res.status})` };
  } catch {
    return { ok: false, error: "Couldn't reach OpenRouter. Check your internet connection." };
  }
}

async function validateDiscordToken(token: string): Promise<{ ok: boolean; error?: string; botName?: string }> {
  try {
    const res = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${token}` },
    });
    if (res.ok) {
      const data = await res.json() as Record<string, unknown>;
      return { ok: true, botName: data.username as string };
    }
    if (res.status === 401) {
      return { ok: false, error: "This bot token was rejected by Discord. Make sure you copied the Token (not the Client ID) from the Bot tab." };
    }
    return { ok: false, error: `Discord validation failed (status ${res.status})` };
  } catch {
    return { ok: false, error: "Couldn't reach Discord's API. Check your internet connection." };
  }
}

async function validateSlackToken(
  botToken: string,
  appToken: string,
): Promise<{ ok: boolean; error?: string; botName?: string }> {
  try {
    const res = await fetch('https://slack.com/api/auth.test', {
      headers: { Authorization: `Bearer ${botToken}` },
    });
    if (!res.ok) {
      return { ok: false, error: `Slack API returned status ${res.status}` };
    }
    const data = await res.json() as Record<string, unknown>;
    if (!data.ok) {
      return { ok: false, error: "This Slack Bot Token wasn't recognized. Copy the Bot User OAuth Token from your app's OAuth page." };
    }
    // Validate app token format
    if (!appToken.startsWith('xapp-')) {
      return { ok: false, error: "The App-Level Token should start with 'xapp-'. Find it in your Slack app's Basic Information page." };
    }
    return { ok: true, botName: data.user as string };
  } catch {
    return { ok: false, error: "Couldn't reach Slack's API. Check your internet connection." };
  }
}

// ── Personality Templates ───────────────────────────────────────────

const PERSONALITY_TEMPLATES: Record<string, string> = {
  entrepreneur: `You are a bold, strategic AI co-founder. You think in terms of leverage, growth, and execution. You challenge assumptions, propose experiments, and focus on outcomes over process. You communicate directly and prefer action over analysis paralysis.`,
  assistant: `You are a helpful, organized, and precise personal assistant. You anticipate needs, keep track of details, and communicate clearly. You're proactive about follow-ups and always confirm before taking significant actions.`,
  developer: `You are a technical co-pilot focused on code quality, problem-solving, and efficient solutions. You think in systems, suggest best practices, and prefer working code over theoretical discussions. You're direct and precise in technical communication.`,
};

// ── Model Routing Configs ───────────────────────────────────────────

const BUDGET_TIERS: Record<string, Record<string, string>> = {
  best: {
    default_model: 'claude-sonnet-4-20250514',
    complex_model: 'claude-opus-4-20250115',
    fast_model: 'claude-haiku-4-5-20251001',
    description: 'Best quality — uses top models for every task',
  },
  balanced: {
    default_model: 'claude-sonnet-4-20250514',
    complex_model: 'claude-sonnet-4-20250514',
    fast_model: 'claude-haiku-4-5-20251001',
    description: 'Balanced — smart routing between quality and speed',
  },
  budget: {
    default_model: 'claude-haiku-4-5-20251001',
    complex_model: 'claude-sonnet-4-20250514',
    fast_model: 'claude-haiku-4-5-20251001',
    description: 'Budget — lightweight models for most tasks',
  },
};

// ── Route Handler ───────────────────────────────────────────────────

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * Handle all /setup* requests. Returns true if the request was handled.
 * Call this BEFORE auth checks in the dashboard server.
 */
export function handleWizardRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  const url = req.url?.split('?')[0] || '';
  if (!url.startsWith('/setup')) return false;

  // Localhost guard
  if (!isLocalhost(req)) {
    sendJson(res, 403, { error: 'Setup wizard is only available from localhost' });
    return true;
  }

  // First-run guard — block after setup complete (except redirect)
  if (isWizardComplete() && url !== '/setup') {
    sendJson(res, 403, { error: 'Setup already completed' });
    return true;
  }

  // Redirect completed wizard to dashboard
  if (isWizardComplete() && url === '/setup') {
    res.writeHead(302, { Location: '/' });
    res.end();
    return true;
  }

  // CORS for POST
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }

  // Route
  if (url === '/setup' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getWizardHtml());
    return true;
  }

  if (url === '/setup/api/state' && req.method === 'GET') {
    sendJson(res, 200, readWizardState());
    return true;
  }

  if (url === '/setup/api/check' && req.method === 'POST') {
    handleCheckEndpoint(req, res);
    return true;
  }

  if (url === '/setup/api/identity' && req.method === 'POST') {
    handleIdentityEndpoint(req, res);
    return true;
  }

  if (url === '/setup/api/provider' && req.method === 'POST') {
    handleProviderEndpoint(req, res);
    return true;
  }

  if (url === '/setup/api/channel' && req.method === 'POST') {
    handleChannelEndpoint(req, res);
    return true;
  }

  if (url === '/setup/api/build' && req.method === 'POST') {
    handleBuildEndpoint(req, res);
    return true;
  }

  if (url === '/setup/api/build/stream' && req.method === 'GET') {
    handleBuildStream(req, res);
    return true;
  }

  if (url === '/setup/api/complete' && req.method === 'POST') {
    handleCompleteEndpoint(req, res);
    return true;
  }

  sendJson(res, 404, { error: 'Not found' });
  return true;
}

// ── Endpoint Handlers ───────────────────────────────────────────────

async function handleCheckEndpoint(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  // Check Node version
  const nodeVersion = process.version;

  // Check Docker
  let dockerRunning = false;
  let dockerError = '';
  try {
    const proc = spawn('docker', ['info'], { stdio: ['ignore', 'pipe', 'pipe'] });
    dockerRunning = await new Promise<boolean>((resolve) => {
      proc.on('close', (code) => resolve(code === 0));
      proc.on('error', () => resolve(false));
    });
    if (!dockerRunning) {
      dockerError = "Can't connect to Docker. Is Docker Desktop running? Look for the whale icon in your taskbar.";
    }
  } catch {
    dockerError = "Docker doesn't seem to be installed.";
  }

  // Check platform
  const platform = process.platform === 'darwin' ? 'macOS' : process.platform === 'linux' ? 'Linux' : process.platform;

  sendJson(res, 200, {
    nodeVersion,
    dockerRunning,
    dockerError,
    platform,
    allGood: dockerRunning,
  });
}

async function handleIdentityEndpoint(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const body = await parseBody(req);
    const name = (body.name as string || '').trim();
    const personality = (body.personality as string || '').trim();
    const customPersonality = (body.customPersonality as string || '').trim();

    if (!name) {
      sendJson(res, 400, { error: 'Please enter a name for your agent.' });
      return;
    }
    if (!personality) {
      sendJson(res, 400, { error: 'Please choose a personality.' });
      return;
    }

    const state = readWizardState();
    state.agentName = name;
    state.personality = personality;
    state.customPersonality = customPersonality;
    writeWizardState(state);
    markStepComplete('identity');

    // Write agent name to .env
    writeEnvFile({ ASSISTANT_NAME: name });

    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 400, { error: 'Invalid request' });
  }
}

async function handleProviderEndpoint(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const body = await parseBody(req);
    const provider = (body.provider as string || '').trim();
    const apiKey = (body.apiKey as string || '').trim();
    const budgetTier = (body.budgetTier as string || 'balanced').trim();

    if (!provider || !['anthropic', 'openrouter'].includes(provider)) {
      sendJson(res, 400, { error: 'Please choose a provider.' });
      return;
    }
    if (!apiKey) {
      sendJson(res, 400, { error: 'Please paste your API key.' });
      return;
    }

    // Validate key
    const validation = provider === 'anthropic'
      ? await validateAnthropicKey(apiKey)
      : await validateOpenRouterKey(apiKey);

    if (!validation.ok) {
      sendJson(res, 400, { error: validation.error });
      return;
    }

    // Write to .env
    if (provider === 'anthropic') {
      writeEnvFile({
        ANTHROPIC_AUTH_TOKEN: apiKey,
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      });
    } else {
      writeEnvFile({
        ANTHROPIC_AUTH_TOKEN: apiKey,
        ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
      });
    }

    // Save state
    const state = readWizardState();
    state.provider = provider;
    state.budgetTier = budgetTier;
    writeWizardState(state);
    markStepComplete('provider');

    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 400, { error: 'Invalid request' });
  }
}

async function handleChannelEndpoint(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const body = await parseBody(req);
    const channel = (body.channel as string || '').trim();
    const token = (body.token as string || '').trim();
    const appToken = (body.appToken as string || '').trim();

    if (!channel || !['discord', 'slack', 'whatsapp'].includes(channel)) {
      sendJson(res, 400, { error: 'Please choose a channel.' });
      return;
    }

    if (channel === 'whatsapp') {
      // WhatsApp uses QR code — no token needed at this stage
      writeEnvFile({ DISCORD_ONLY: 'false' });
      const state = readWizardState();
      state.channel = channel;
      writeWizardState(state);
      markStepComplete('channel');
      sendJson(res, 200, { ok: true, note: "WhatsApp will show a QR code when the service starts." });
      return;
    }

    if (channel === 'discord') {
      if (!token) {
        sendJson(res, 400, { error: 'Please paste your Discord bot token.' });
        return;
      }
      const validation = await validateDiscordToken(token);
      if (!validation.ok) {
        sendJson(res, 400, { error: validation.error });
        return;
      }
      writeEnvFile({
        DISCORD_BOT_TOKEN: token,
        DISCORD_ONLY: 'true',
      });
      const state = readWizardState();
      state.channel = channel;
      writeWizardState(state);
      markStepComplete('channel');
      sendJson(res, 200, { ok: true, botName: validation.botName });
      return;
    }

    if (channel === 'slack') {
      if (!token) {
        sendJson(res, 400, { error: 'Please paste your Slack Bot Token.' });
        return;
      }
      if (!appToken) {
        sendJson(res, 400, { error: 'Please paste your Slack App-Level Token.' });
        return;
      }
      const validation = await validateSlackToken(token, appToken);
      if (!validation.ok) {
        sendJson(res, 400, { error: validation.error });
        return;
      }
      writeEnvFile({
        SLACK_BOT_TOKEN: token,
        SLACK_APP_TOKEN: appToken,
        DISCORD_ONLY: 'false',
      });
      const state = readWizardState();
      state.channel = channel;
      writeWizardState(state);
      markStepComplete('channel');
      sendJson(res, 200, { ok: true, botName: validation.botName });
      return;
    }
  } catch (err) {
    sendJson(res, 400, { error: 'Invalid request' });
  }
}

async function handleBuildEndpoint(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const state = readWizardState();
  const name = state.agentName || 'Agent';

  // Fire and forget — build runs in background
  startBuild(name).catch((err) => {
    logger.error({ err }, 'Build failed');
  });

  sendJson(res, 200, { ok: true, message: `Starting build for ${name}...` });
}

function handleBuildStream(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // Send current state immediately
  const data = JSON.stringify({
    status: buildJob.status,
    currentPhase: buildJob.currentPhase,
    phases: buildJob.phases,
    error: buildJob.error,
  });
  res.write(`data: ${data}\n\n`);

  sseClients.add(res);
  res.on('close', () => sseClients.delete(res));
}

async function handleCompleteEndpoint(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const state = readWizardState();
    const name = state.agentName || 'Agent';

    // Write personality to groups/main/CLAUDE.md
    const mainGroupDir = path.join(GROUPS_DIR, 'main');
    fs.mkdirSync(mainGroupDir, { recursive: true });
    const claudeMdPath = path.join(mainGroupDir, 'CLAUDE.md');

    let personalityText = '';
    if (state.personality === 'custom') {
      personalityText = state.customPersonality;
    } else {
      personalityText = PERSONALITY_TEMPLATES[state.personality] || '';
    }

    const claudeMd = `# ${name}\n\n## Personality\n\n${personalityText}\n`;

    // Append if exists, write if not
    if (fs.existsSync(claudeMdPath)) {
      const existing = fs.readFileSync(claudeMdPath, 'utf-8');
      if (!existing.includes('## Personality')) {
        fs.appendFileSync(claudeMdPath, '\n' + claudeMd);
      }
    } else {
      fs.writeFileSync(claudeMdPath, claudeMd);
    }

    // Write model routing config
    const tier = BUDGET_TIERS[state.budgetTier] || BUDGET_TIERS.balanced;
    const routingConfig = {
      default_model: tier.default_model,
      complex_model: tier.complex_model,
      fast_model: tier.fast_model,
    };
    const routingPath = path.join(STORE_DIR, 'model-routing.json');
    fs.mkdirSync(path.dirname(routingPath), { recursive: true });
    fs.writeFileSync(routingPath, JSON.stringify(routingConfig, null, 2));

    // Write dashboard env
    writeEnvFile({
      DASHBOARD_ENABLED: 'true',
      DASHBOARD_ALLOW_UNAUTH: 'true',
    });

    markStepComplete('done');
    sendJson(res, 200, { ok: true, agentName: name });
  } catch (err) {
    sendJson(res, 500, { error: 'Failed to complete setup' });
  }
}

// ── SPA HTML ────────────────────────────────────────────────────────

function getWizardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sovereign Setup</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0d1117;
      color: #c9d1d9;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
    }

    /* Progress Bar */
    .progress-bar {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: #21262d;
      z-index: 100;
    }
    .progress-fill {
      height: 100%;
      background: linear-gradient(90deg, #58a6ff, #3fb950);
      transition: width 0.5s ease;
      border-radius: 0 2px 2px 0;
    }

    /* Container */
    .wizard {
      max-width: 560px;
      width: 100%;
      padding: 48px 24px;
      margin: 0 auto;
    }
    .logo {
      text-align: center;
      margin-bottom: 40px;
    }
    .logo h1 {
      color: #f0f6fc;
      font-size: 28px;
      font-weight: 600;
    }
    .logo p {
      color: #8b949e;
      font-size: 14px;
      margin-top: 6px;
    }

    /* Steps */
    .step {
      display: none;
      opacity: 0;
      transform: translateY(12px);
      transition: opacity 0.35s ease, transform 0.35s ease;
    }
    .step.active {
      display: block;
      opacity: 1;
      transform: translateY(0);
    }
    .step h2 {
      color: #f0f6fc;
      font-size: 22px;
      margin-bottom: 8px;
    }
    .step .desc {
      color: #8b949e;
      font-size: 14px;
      margin-bottom: 24px;
      line-height: 1.5;
    }

    /* Inputs */
    label {
      display: block;
      color: #8b949e;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 6px;
      margin-top: 16px;
    }
    input[type="text"], input[type="password"], textarea {
      width: 100%;
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 6px;
      padding: 10px 12px;
      color: #f0f6fc;
      font-size: 15px;
      outline: none;
      transition: border-color 0.2s;
    }
    input:focus, textarea:focus {
      border-color: #58a6ff;
    }
    textarea {
      min-height: 100px;
      resize: vertical;
      font-family: inherit;
    }

    /* Selection Cards */
    .cards {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-top: 8px;
    }
    .cards.triple {
      grid-template-columns: 1fr 1fr 1fr;
    }
    .card {
      background: #161b22;
      border: 2px solid #30363d;
      border-radius: 8px;
      padding: 16px 14px;
      cursor: pointer;
      transition: border-color 0.2s, background 0.2s;
      text-align: center;
    }
    .card:hover {
      border-color: #484f58;
      background: #1c2129;
    }
    .card.selected {
      border-color: #58a6ff;
      background: #161b22;
    }
    .card .card-icon {
      font-size: 28px;
      margin-bottom: 8px;
    }
    .card .card-title {
      color: #f0f6fc;
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 4px;
    }
    .card .card-desc {
      color: #8b949e;
      font-size: 12px;
      line-height: 1.4;
    }

    /* Buttons */
    .actions {
      display: flex;
      gap: 12px;
      margin-top: 32px;
    }
    .btn {
      padding: 10px 24px;
      border-radius: 6px;
      border: none;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.2s, opacity 0.2s;
    }
    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .btn-primary {
      background: #238636;
      color: #fff;
      flex: 1;
    }
    .btn-primary:hover:not(:disabled) {
      background: #2ea043;
    }
    .btn-secondary {
      background: #21262d;
      color: #c9d1d9;
    }
    .btn-secondary:hover:not(:disabled) {
      background: #30363d;
    }

    /* Error */
    .error-msg {
      background: #3d1418;
      border: 1px solid #f85149;
      color: #f85149;
      padding: 10px 14px;
      border-radius: 6px;
      font-size: 13px;
      margin-top: 16px;
      display: none;
      line-height: 1.4;
    }
    .error-msg.visible { display: block; }

    /* Check items */
    .check-list {
      list-style: none;
      margin-top: 16px;
    }
    .check-list li {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 0;
      border-bottom: 1px solid #21262d;
      font-size: 14px;
    }
    .check-icon {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      flex-shrink: 0;
    }
    .check-icon.pass { background: #238636; color: #fff; }
    .check-icon.fail { background: #da3633; color: #fff; }
    .check-icon.loading { background: #30363d; color: #8b949e; }

    /* Build Progress */
    .build-phases {
      list-style: none;
      margin-top: 20px;
    }
    .build-phases li {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 14px 0;
      border-bottom: 1px solid #21262d;
      font-size: 14px;
    }
    .phase-status {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      flex-shrink: 0;
    }
    .phase-status.pending { background: #21262d; color: #484f58; }
    .phase-status.running { background: #1f6feb; color: #fff; animation: pulse 1.5s infinite; }
    .phase-status.done { background: #238636; color: #fff; }
    .phase-status.failed { background: #da3633; color: #fff; }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    /* Build log toggle */
    .log-toggle {
      color: #484f58;
      font-size: 12px;
      cursor: pointer;
      margin-top: 16px;
      user-select: none;
    }
    .log-toggle:hover { color: #8b949e; }
    .build-log {
      display: none;
      background: #0d1117;
      border: 1px solid #21262d;
      border-radius: 6px;
      padding: 12px;
      margin-top: 8px;
      max-height: 200px;
      overflow-y: auto;
      font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
      font-size: 11px;
      color: #8b949e;
      line-height: 1.6;
    }
    .build-log.visible { display: block; }

    /* Done screen */
    .done-icon {
      text-align: center;
      font-size: 64px;
      margin: 24px 0;
    }
    .done-title {
      text-align: center;
      color: #3fb950;
      font-size: 24px;
      font-weight: 600;
      margin-bottom: 12px;
    }
    .done-desc {
      text-align: center;
      color: #8b949e;
      font-size: 14px;
      line-height: 1.5;
      margin-bottom: 32px;
    }
    .tip-box {
      background: #161b22;
      border: 1px solid #21262d;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 16px;
    }
    .tip-box h3 {
      color: #58a6ff;
      font-size: 13px;
      margin-bottom: 8px;
    }
    .tip-box p {
      color: #8b949e;
      font-size: 13px;
      line-height: 1.5;
    }

    /* Loading spinner for buttons */
    .btn.loading {
      pointer-events: none;
      position: relative;
      color: transparent;
    }
    .btn.loading::after {
      content: '';
      position: absolute;
      width: 16px;
      height: 16px;
      border: 2px solid #fff;
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
      left: 50%;
      top: 50%;
      margin: -8px 0 0 -8px;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    /* Token field section that hides initially */
    .token-section {
      display: none;
      margin-top: 16px;
    }
    .token-section.visible { display: block; }

    /* Custom personality textarea section */
    .custom-personality {
      display: none;
      margin-top: 12px;
    }
    .custom-personality.visible { display: block; }

    /* Budget tier that shows after provider */
    .budget-section {
      display: none;
      margin-top: 24px;
    }
    .budget-section.visible { display: block; }
  </style>
</head>
<body>
  <div class="progress-bar"><div class="progress-fill" id="progressFill" style="width: 0%"></div></div>

  <div class="wizard">
    <div class="logo">
      <h1>Sovereign</h1>
      <p>Let's set up your AI agent</p>
    </div>

    <!-- Step 1: Welcome -->
    <div class="step active" id="step-welcome">
      <h2>Welcome</h2>
      <p class="desc">First, let's make sure your system is ready. This only takes a moment.</p>
      <ul class="check-list" id="checkList">
        <li><span class="check-icon loading" id="checkNode">...</span> <span id="checkNodeLabel">Checking Node.js...</span></li>
        <li><span class="check-icon loading" id="checkDocker">...</span> <span id="checkDockerLabel">Checking Docker...</span></li>
      </ul>
      <div class="error-msg" id="welcomeError"></div>
      <div class="actions">
        <button class="btn btn-primary" id="welcomeNext" disabled>Next</button>
      </div>
    </div>

    <!-- Step 2: Identity -->
    <div class="step" id="step-identity">
      <h2>Who is your agent?</h2>
      <p class="desc">Give your agent a name and personality. This shapes how it communicates.</p>
      <label for="agentName">Agent Name</label>
      <input type="text" id="agentName" placeholder="Adam" value="">
      <label>Personality</label>
      <div class="cards" id="personalityCards">
        <div class="card" data-value="entrepreneur">
          <div class="card-title">Entrepreneur</div>
          <div class="card-desc">Bold, strategic, growth-focused</div>
        </div>
        <div class="card" data-value="assistant">
          <div class="card-title">Assistant</div>
          <div class="card-desc">Helpful, organized, precise</div>
        </div>
        <div class="card" data-value="developer">
          <div class="card-title">Developer</div>
          <div class="card-desc">Technical, problem-solving</div>
        </div>
        <div class="card" data-value="custom">
          <div class="card-title">Custom</div>
          <div class="card-desc">Write your own</div>
        </div>
      </div>
      <div class="custom-personality" id="customPersonalitySection">
        <label for="customPersonality">Describe your agent's personality</label>
        <textarea id="customPersonality" placeholder="You are a..."></textarea>
      </div>
      <div class="error-msg" id="identityError"></div>
      <div class="actions">
        <button class="btn btn-secondary" onclick="goBack()">Back</button>
        <button class="btn btn-primary" id="identityNext">Next</button>
      </div>
    </div>

    <!-- Step 3: AI Engine (Provider + Budget) -->
    <div class="step" id="step-provider">
      <h2>Give <span class="agent-name">your agent</span> its brain</h2>
      <p class="desc">Choose an AI provider and paste your API key. We'll validate it instantly.</p>
      <label>Provider</label>
      <div class="cards" id="providerCards">
        <div class="card" data-value="anthropic">
          <div class="card-title">Anthropic</div>
          <div class="card-desc">Direct API access</div>
        </div>
        <div class="card" data-value="openrouter">
          <div class="card-title">OpenRouter</div>
          <div class="card-desc">Multi-model gateway</div>
        </div>
      </div>
      <div class="token-section" id="providerKeySection">
        <label for="apiKey">API Key</label>
        <input type="password" id="apiKey" placeholder="sk-ant-... or sk-or-...">
        <p style="color:#484f58;font-size:12px;margin-top:6px" id="providerHint"></p>
      </div>
      <div class="budget-section" id="budgetSection">
        <label>Quality Tier</label>
        <div class="cards triple" id="budgetCards">
          <div class="card selected" data-value="best">
            <div class="card-title">Best</div>
            <div class="card-desc">Top models always</div>
          </div>
          <div class="card" data-value="balanced">
            <div class="card-title">Balanced</div>
            <div class="card-desc">Smart routing</div>
          </div>
          <div class="card" data-value="budget">
            <div class="card-title">Budget</div>
            <div class="card-desc">Cost-efficient</div>
          </div>
        </div>
      </div>
      <div class="error-msg" id="providerError"></div>
      <div class="actions">
        <button class="btn btn-secondary" onclick="goBack()">Back</button>
        <button class="btn btn-primary" id="providerNext">Next</button>
      </div>
    </div>

    <!-- Step 4: Channel -->
    <div class="step" id="step-channel">
      <h2>Where will <span class="agent-name">your agent</span> live?</h2>
      <p class="desc">Choose a messaging platform. You can add more channels later.</p>
      <div class="cards triple" id="channelCards">
        <div class="card" data-value="discord">
          <div class="card-title">Discord</div>
          <div class="card-desc">Server bot</div>
        </div>
        <div class="card" data-value="slack">
          <div class="card-title">Slack</div>
          <div class="card-desc">Workspace app</div>
        </div>
        <div class="card" data-value="whatsapp">
          <div class="card-title">WhatsApp</div>
          <div class="card-desc">QR code link</div>
        </div>
      </div>
      <div class="token-section" id="channelTokenSection">
        <div id="channelInstructions" style="background:#161b22;border:1px solid #21262d;border-radius:6px;padding:14px;margin-bottom:12px;font-size:13px;color:#8b949e;line-height:1.6"></div>
        <label for="channelToken" id="channelTokenLabel">Bot Token</label>
        <input type="password" id="channelToken" placeholder="">
        <div id="slackAppTokenSection" style="display:none;margin-top:12px">
          <label for="slackAppToken">App-Level Token</label>
          <input type="password" id="slackAppToken" placeholder="xapp-...">
        </div>
      </div>
      <div class="error-msg" id="channelError"></div>
      <div class="actions">
        <button class="btn btn-secondary" onclick="goBack()">Back</button>
        <button class="btn btn-primary" id="channelNext">Next</button>
      </div>
    </div>

    <!-- Step 5: Build -->
    <div class="step" id="step-build">
      <h2>Waking up <span class="agent-name">your agent</span>...</h2>
      <p class="desc">This takes 3-5 minutes. You can leave this tab open.</p>
      <ul class="build-phases" id="buildPhases"></ul>
      <div class="error-msg" id="buildError"></div>
      <div class="log-toggle" id="logToggle" onclick="toggleLog()">Show technical details</div>
      <div class="build-log" id="buildLog"></div>
      <div class="actions" id="buildActions" style="display:none">
        <button class="btn btn-primary" id="buildRetry" onclick="startBuild()">Try Again</button>
      </div>
    </div>

    <!-- Step 6: Done -->
    <div class="step" id="step-done">
      <div class="done-icon">&#10024;</div>
      <div class="done-title"><span class="agent-name">Your agent</span> is alive!</div>
      <div class="done-desc">Everything is set up and running. Here's how to get started.</div>
      <div class="tip-box" id="channelTip">
        <h3>Start chatting</h3>
        <p id="channelTipText">Send a message to your agent on your chosen platform.</p>
      </div>
      <div class="tip-box">
        <h3>Dashboard</h3>
        <p>Monitor your agent's activity, memory, and groups from the dashboard.</p>
      </div>
      <div class="actions">
        <button class="btn btn-primary" onclick="window.location.href='/'">Open Dashboard</button>
      </div>
    </div>
  </div>

  <script>
    // State
    var currentStep = 0;
    var steps = ['welcome', 'identity', 'provider', 'channel', 'build', 'done'];
    var selectedPersonality = '';
    var selectedProvider = '';
    var selectedBudget = 'best';
    var selectedChannel = '';
    var agentName = 'your agent';
    var buildEventSource = null;

    // Step navigation
    function goToStep(index) {
      steps.forEach(function(name, i) {
        var el = document.getElementById('step-' + name);
        if (i === index) {
          el.classList.add('active');
          setTimeout(function() { el.style.opacity = '1'; el.style.transform = 'translateY(0)'; }, 10);
        } else {
          el.classList.remove('active');
          el.style.opacity = '0';
          el.style.transform = 'translateY(12px)';
        }
      });
      currentStep = index;
      document.getElementById('progressFill').style.width = ((index / (steps.length - 1)) * 100) + '%';
      updateAgentNames();
    }

    function goBack() {
      if (currentStep > 0) goToStep(currentStep - 1);
    }

    function updateAgentNames() {
      var spans = document.querySelectorAll('.agent-name');
      for (var i = 0; i < spans.length; i++) {
        spans[i].textContent = agentName || 'your agent';
      }
    }

    function showError(id, msg) {
      var el = document.getElementById(id);
      el.textContent = msg;
      el.classList.add('visible');
    }

    function hideError(id) {
      document.getElementById(id).classList.remove('visible');
    }

    function setLoading(btn, loading) {
      if (loading) btn.classList.add('loading');
      else btn.classList.remove('loading');
      btn.disabled = loading;
    }

    // Card selection helper
    function setupCards(containerId, callback) {
      var container = document.getElementById(containerId);
      container.addEventListener('click', function(e) {
        var card = e.target.closest('.card');
        if (!card) return;
        container.querySelectorAll('.card').forEach(function(c) { c.classList.remove('selected'); });
        card.classList.add('selected');
        callback(card.dataset.value);
      });
    }

    // Step 1: Welcome — auto-run checks
    (function() {
      fetch('/setup/api/check', { method: 'POST' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          var nodeIcon = document.getElementById('checkNode');
          var nodeLabel = document.getElementById('checkNodeLabel');
          nodeIcon.className = 'check-icon pass';
          nodeIcon.textContent = '\\u2713';
          nodeLabel.textContent = 'Node.js ' + data.nodeVersion + ' (' + data.platform + ')';

          var dockerIcon = document.getElementById('checkDocker');
          var dockerLabel = document.getElementById('checkDockerLabel');
          if (data.dockerRunning) {
            dockerIcon.className = 'check-icon pass';
            dockerIcon.textContent = '\\u2713';
            dockerLabel.textContent = 'Docker is running';
            document.getElementById('welcomeNext').disabled = false;
          } else {
            dockerIcon.className = 'check-icon fail';
            dockerIcon.textContent = '\\u2717';
            dockerLabel.textContent = 'Docker not running';
            showError('welcomeError', data.dockerError || 'Docker is required. Please install and start Docker Desktop.');
          }
        })
        .catch(function() {
          showError('welcomeError', 'Failed to check system requirements.');
        });

      document.getElementById('welcomeNext').addEventListener('click', function() {
        goToStep(1);
      });
    })();

    // Step 2: Identity
    setupCards('personalityCards', function(val) {
      selectedPersonality = val;
      var custom = document.getElementById('customPersonalitySection');
      if (val === 'custom') custom.classList.add('visible');
      else custom.classList.remove('visible');
    });

    document.getElementById('identityNext').addEventListener('click', function() {
      var btn = this;
      var name = document.getElementById('agentName').value.trim() || 'Adam';
      hideError('identityError');

      if (!selectedPersonality) {
        showError('identityError', 'Please choose a personality for your agent.');
        return;
      }

      setLoading(btn, true);
      fetch('/setup/api/identity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name,
          personality: selectedPersonality,
          customPersonality: document.getElementById('customPersonality').value
        })
      })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        setLoading(btn, false);
        if (data.error) { showError('identityError', data.error); return; }
        agentName = name;
        updateAgentNames();
        goToStep(2);
      })
      .catch(function() {
        setLoading(btn, false);
        showError('identityError', 'Something went wrong. Please try again.');
      });
    });

    // Step 3: Provider
    setupCards('providerCards', function(val) {
      selectedProvider = val;
      document.getElementById('providerKeySection').classList.add('visible');
      document.getElementById('budgetSection').classList.add('visible');
      var hint = document.getElementById('providerHint');
      if (val === 'anthropic') {
        hint.textContent = 'Get your key at console.anthropic.com/settings/keys';
        document.getElementById('apiKey').placeholder = 'sk-ant-...';
      } else {
        hint.textContent = 'Get your key at openrouter.ai/settings/keys';
        document.getElementById('apiKey').placeholder = 'sk-or-...';
      }
    });

    setupCards('budgetCards', function(val) {
      selectedBudget = val;
    });

    document.getElementById('providerNext').addEventListener('click', function() {
      var btn = this;
      var key = document.getElementById('apiKey').value.trim();
      hideError('providerError');

      if (!selectedProvider) {
        showError('providerError', 'Please choose a provider.');
        return;
      }
      if (!key) {
        showError('providerError', 'Please paste your API key.');
        return;
      }

      setLoading(btn, true);
      fetch('/setup/api/provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: selectedProvider,
          apiKey: key,
          budgetTier: selectedBudget
        })
      })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        setLoading(btn, false);
        if (data.error) { showError('providerError', data.error); return; }
        goToStep(3);
      })
      .catch(function() {
        setLoading(btn, false);
        showError('providerError', 'Something went wrong. Please try again.');
      });
    });

    // Step 4: Channel
    var channelInstructionsMap = {
      discord: '<strong>How to get a Discord bot token:</strong><br>1. Go to <a href="https://discord.com/developers/applications" target="_blank" style="color:#58a6ff">Discord Developer Portal</a><br>2. Click "New Application" and give it a name<br>3. Go to the "Bot" tab on the left<br>4. Click "Reset Token" and copy it<br>5. Under "Privileged Gateway Intents", enable Message Content Intent<br>6. Go to OAuth2 > URL Generator, select "bot" scope with Send Messages permission<br>7. Open the generated URL to invite the bot to your server',
      slack: '<strong>How to set up a Slack app:</strong><br>1. Go to <a href="https://api.slack.com/apps" target="_blank" style="color:#58a6ff">Slack API Apps</a><br>2. Click "Create New App" > "From scratch"<br>3. Go to "Socket Mode" and enable it — copy the App-Level Token (xapp-...)<br>4. Go to "OAuth & Permissions" > add bot scopes: chat:write, channels:history, channels:read<br>5. Install to workspace and copy the Bot User OAuth Token (xoxb-...)',
      whatsapp: '<strong>WhatsApp connects via QR code.</strong><br>When the service starts, a QR code will appear in the terminal. Scan it with WhatsApp on your phone to link the bot.'
    };

    setupCards('channelCards', function(val) {
      selectedChannel = val;
      var tokenSection = document.getElementById('channelTokenSection');
      var instructions = document.getElementById('channelInstructions');
      var slackSection = document.getElementById('slackAppTokenSection');

      instructions.innerHTML = channelInstructionsMap[val] || '';

      if (val === 'whatsapp') {
        tokenSection.classList.add('visible');
        document.getElementById('channelToken').style.display = 'none';
        document.getElementById('channelTokenLabel').style.display = 'none';
        slackSection.style.display = 'none';
      } else {
        tokenSection.classList.add('visible');
        document.getElementById('channelToken').style.display = '';
        document.getElementById('channelTokenLabel').style.display = '';
        if (val === 'discord') {
          document.getElementById('channelTokenLabel').textContent = 'Bot Token';
          document.getElementById('channelToken').placeholder = 'Paste your Discord bot token...';
          slackSection.style.display = 'none';
        } else if (val === 'slack') {
          document.getElementById('channelTokenLabel').textContent = 'Bot User OAuth Token';
          document.getElementById('channelToken').placeholder = 'xoxb-...';
          slackSection.style.display = 'block';
        }
      }
    });

    document.getElementById('channelNext').addEventListener('click', function() {
      var btn = this;
      hideError('channelError');

      if (!selectedChannel) {
        showError('channelError', 'Please choose a channel.');
        return;
      }

      var payload = { channel: selectedChannel };
      if (selectedChannel !== 'whatsapp') {
        payload.token = document.getElementById('channelToken').value.trim();
        if (!payload.token) {
          showError('channelError', 'Please paste your bot token.');
          return;
        }
      }
      if (selectedChannel === 'slack') {
        payload.appToken = document.getElementById('slackAppToken').value.trim();
        if (!payload.appToken) {
          showError('channelError', 'Please paste your Slack App-Level Token.');
          return;
        }
      }

      setLoading(btn, true);
      fetch('/setup/api/channel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        setLoading(btn, false);
        if (data.error) { showError('channelError', data.error); return; }
        goToStep(4);
        startBuild();
      })
      .catch(function() {
        setLoading(btn, false);
        showError('channelError', 'Something went wrong. Please try again.');
      });
    });

    // Step 5: Build
    function startBuild() {
      hideError('buildError');
      document.getElementById('buildActions').style.display = 'none';

      fetch('/setup/api/build', { method: 'POST' })
        .then(function(r) { return r.json(); })
        .then(function() { connectBuildStream(); })
        .catch(function() { showError('buildError', 'Failed to start build.'); });
    }

    function connectBuildStream() {
      if (buildEventSource) buildEventSource.close();
      buildEventSource = new EventSource('/setup/api/build/stream');

      buildEventSource.onmessage = function(event) {
        var data = JSON.parse(event.data);
        renderBuildPhases(data);

        if (data.status === 'done') {
          buildEventSource.close();
          completeSetup();
        }
        if (data.status === 'failed') {
          buildEventSource.close();
          showError('buildError', data.error || 'Build failed. Check the technical details below.');
          document.getElementById('buildActions').style.display = 'flex';
        }
      };

      buildEventSource.onerror = function() {
        buildEventSource.close();
      };
    }

    function renderBuildPhases(data) {
      var list = document.getElementById('buildPhases');
      list.innerHTML = '';
      (data.phases || []).forEach(function(phase) {
        var li = document.createElement('li');
        var icon = document.createElement('span');
        icon.className = 'phase-status ' + phase.status;
        if (phase.status === 'done') icon.textContent = '\\u2713';
        else if (phase.status === 'failed') icon.textContent = '\\u2717';
        else if (phase.status === 'running') icon.textContent = '\\u25CB';
        else icon.textContent = '\\u25CB';
        var label = document.createElement('span');
        label.textContent = phase.label;
        li.appendChild(icon);
        li.appendChild(label);
        list.appendChild(li);
      });
    }

    function toggleLog() {
      var log = document.getElementById('buildLog');
      var toggle = document.getElementById('logToggle');
      if (log.classList.contains('visible')) {
        log.classList.remove('visible');
        toggle.textContent = 'Show technical details';
      } else {
        log.classList.add('visible');
        toggle.textContent = 'Hide technical details';
        // Fetch raw log
        fetch('/setup/api/state').then(function(r) { return r.json(); });
      }
    }

    // Step 6: Complete
    function completeSetup() {
      fetch('/setup/api/complete', { method: 'POST' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.error) {
            showError('buildError', data.error);
            return;
          }
          // Set channel-specific tip
          var tipText = document.getElementById('channelTipText');
          if (selectedChannel === 'discord') {
            tipText.textContent = 'Send a message starting with @' + agentName + ' in any Discord channel where the bot is present.';
          } else if (selectedChannel === 'slack') {
            tipText.textContent = 'Mention @' + agentName + ' in any Slack channel where the app is installed.';
          } else {
            tipText.textContent = 'Send a message to the WhatsApp number linked to your agent.';
          }
          goToStep(5);
        })
        .catch(function() {
          showError('buildError', 'Failed to complete setup.');
        });
    }

    // Load saved state on page load
    fetch('/setup/api/state')
      .then(function(r) { return r.json(); })
      .then(function(state) {
        if (state.agentName) {
          agentName = state.agentName;
          document.getElementById('agentName').value = state.agentName;
          updateAgentNames();
        }
        if (state.personality) {
          selectedPersonality = state.personality;
          var card = document.querySelector('#personalityCards .card[data-value="' + state.personality + '"]');
          if (card) card.classList.add('selected');
          if (state.personality === 'custom' && state.customPersonality) {
            document.getElementById('customPersonalitySection').classList.add('visible');
            document.getElementById('customPersonality').value = state.customPersonality;
          }
        }
        // Resume at furthest completed step
        var completed = state.completedSteps || [];
        if (completed.includes('done')) {
          window.location.href = '/';
        } else if (completed.includes('channel')) {
          goToStep(4);
        } else if (completed.includes('provider')) {
          goToStep(3);
        } else if (completed.includes('identity')) {
          goToStep(2);
        }
      })
      .catch(function() {});
  </script>
</body>
</html>`;
}
