/**
 * Sentry Agent — automated incident triage for Sovereign.
 * Receives alert webhooks (Sentry, UptimeRobot, generic), classifies severity,
 * and posts summaries to a configured channel. Can auto-fix known issues.
 */
import fs from 'fs';
import path from 'path';
import http from 'http';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

// ── Types ──────────────────────────────────────────────────────────

export type Severity = 'critical' | 'warning' | 'info';

export interface Alert {
  id: string;
  source: string;
  title: string;
  message: string;
  severity: Severity;
  service: string;
  timestamp: string;
  raw: Record<string, unknown>;
}

export interface TriageResult {
  alert: Alert;
  summary: string;
  recommendedAction: string;
  autoFixAvailable: boolean;
  autoFixId?: string;
}

export interface AutoFix {
  id: string;
  pattern: string; // Regex pattern to match alert title/message
  description: string;
  command: string; // Shell command to execute
}

export interface SentryAgentConfig {
  port: number;
  channelJid: string; // Where to post summaries (e.g., "dc:123" or "slack:C456")
  autoFixes?: AutoFix[];
  webhookSecret?: string; // Optional shared secret for auth
}

// ── Alert Parsing ──────────────────────────────────────────────────

/**
 * Parse a Sentry webhook payload into a normalized Alert.
 */
export function parseSentryPayload(body: Record<string, unknown>): Alert {
  const data = (body.data || {}) as Record<string, unknown>;
  const event = (data.event || data.issue || {}) as Record<string, unknown>;
  const title = (event.title || body.action || 'Unknown') as string;
  const message = (event.message || event.culprit || title) as string;

  return {
    id: `sentry-${Date.now()}`,
    source: 'sentry',
    title,
    message,
    severity: classifySeverity(title, message, 'sentry'),
    service: ((event.project || 'unknown') as string),
    timestamp: new Date().toISOString(),
    raw: body,
  };
}

/**
 * Parse an UptimeRobot webhook payload into a normalized Alert.
 */
export function parseUptimeRobotPayload(body: Record<string, unknown>): Alert {
  const monitorName = (body.monitorFriendlyName || body.monitor_friendly_name || 'Unknown') as string;
  const alertType = (body.alertType || body.alert_type || '1') as string;
  const isDown = alertType === '1' || String(body.alertTypeFriendlyName).toLowerCase().includes('down');

  return {
    id: `uptimerobot-${Date.now()}`,
    source: 'uptimerobot',
    title: isDown ? `🔴 ${monitorName} is DOWN` : `🟢 ${monitorName} is UP`,
    message: `Monitor: ${monitorName}, Type: ${body.alertTypeFriendlyName || alertType}`,
    severity: isDown ? 'critical' : 'info',
    service: monitorName,
    timestamp: new Date().toISOString(),
    raw: body,
  };
}

/**
 * Parse a generic webhook payload into a normalized Alert.
 */
export function parseGenericPayload(body: Record<string, unknown>): Alert {
  const title = (body.title || body.name || body.subject || 'Alert') as string;
  const message = (body.message || body.body || body.text || title) as string;
  const severity = (body.severity || body.level || body.priority) as string | undefined;

  return {
    id: `generic-${Date.now()}`,
    source: 'generic',
    title,
    message,
    severity: severity ? normalizeSeverity(severity) : classifySeverity(title, message, 'generic'),
    service: (body.service || body.project || 'unknown') as string,
    timestamp: new Date().toISOString(),
    raw: body,
  };
}

// ── Classification ─────────────────────────────────────────────────

const CRITICAL_PATTERNS = [
  /down/i, /crash/i, /fatal/i, /outage/i, /unresponsive/i,
  /oom/i, /out of memory/i, /disk full/i, /502/i, /503/i, /500/i,
];

const WARNING_PATTERNS = [
  /slow/i, /timeout/i, /retry/i, /degraded/i, /high.*(cpu|memory|latency)/i,
  /rate.?limit/i, /429/i, /connection.*(refused|reset)/i,
];

/**
 * Classify alert severity based on content patterns.
 */
export function classifySeverity(title: string, message: string, _source: string): Severity {
  const text = `${title} ${message}`;
  if (CRITICAL_PATTERNS.some((p) => p.test(text))) return 'critical';
  if (WARNING_PATTERNS.some((p) => p.test(text))) return 'warning';
  return 'info';
}

function normalizeSeverity(raw: string): Severity {
  const lower = raw.toLowerCase();
  if (['critical', 'fatal', 'error', 'high', 'p1'].includes(lower)) return 'critical';
  if (['warning', 'warn', 'medium', 'p2'].includes(lower)) return 'warning';
  return 'info';
}

// ── Triage ─────────────────────────────────────────────────────────

/**
 * Triage an alert: generate summary and check for auto-fixes.
 */
export function triageAlert(alert: Alert, autoFixes: AutoFix[] = []): TriageResult {
  const severityEmoji = { critical: '🔴', warning: '🟡', info: '🔵' }[alert.severity];

  const summary = [
    `${severityEmoji} **${alert.severity.toUpperCase()}** — ${alert.title}`,
    `Service: ${alert.service} | Source: ${alert.source}`,
    alert.message !== alert.title ? `Details: ${alert.message}` : '',
  ].filter(Boolean).join('\n');

  // Check for matching auto-fixes
  const text = `${alert.title} ${alert.message}`;
  const matchingFix = autoFixes.find((fix) => new RegExp(fix.pattern, 'i').test(text));

  const recommendedAction = matchingFix
    ? `Auto-fix available: ${matchingFix.description}`
    : suggestAction(alert);

  return {
    alert,
    summary,
    recommendedAction,
    autoFixAvailable: !!matchingFix,
    autoFixId: matchingFix?.id,
  };
}

function suggestAction(alert: Alert): string {
  switch (alert.severity) {
    case 'critical':
      return 'Investigate immediately. Check service logs and recent deploys.';
    case 'warning':
      return 'Monitor closely. May resolve on its own or escalate.';
    case 'info':
      return 'No action needed. Logged for reference.';
  }
}

// ── Format ─────────────────────────────────────────────────────────

/**
 * Format a triage result for posting to a channel.
 */
export function formatTriageMessage(result: TriageResult): string {
  const parts = [result.summary, '', `→ ${result.recommendedAction}`];
  if (result.autoFixAvailable) {
    parts.push(`⚡ Auto-fix: \`${result.autoFixId}\``);
  }
  return parts.join('\n');
}

// ── Webhook Server ─────────────────────────────────────────────────

/**
 * Start the webhook receiver HTTP server.
 */
export function startSentryAgent(
  config: SentryAgentConfig,
  sendMessage: (jid: string, text: string) => Promise<void>,
): http.Server {
  const autoFixes = config.autoFixes || loadAutoFixes();

  const server = http.createServer(async (req, res) => {
    // Only accept POST to /webhook/* paths
    if (req.method !== 'POST' || !req.url?.startsWith('/webhook/')) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    // Optional webhook secret validation
    if (config.webhookSecret) {
      const authHeader = req.headers['x-webhook-secret'] || req.headers['authorization'];
      if (authHeader !== config.webhookSecret && authHeader !== `Bearer ${config.webhookSecret}`) {
        res.writeHead(401);
        res.end('Unauthorized');
        return;
      }
    }

    // Read body
    let body: Record<string, unknown>;
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    } catch {
      res.writeHead(400);
      res.end('Invalid JSON');
      return;
    }

    // Route to parser based on URL path
    const source = req.url.replace('/webhook/', '').split('/')[0];
    let alert: Alert;

    switch (source) {
      case 'sentry':
        alert = parseSentryPayload(body);
        break;
      case 'uptimerobot':
        alert = parseUptimeRobotPayload(body);
        break;
      default:
        alert = parseGenericPayload(body);
        break;
    }

    // Triage
    const result = triageAlert(alert, autoFixes);

    // Post to channel
    const message = formatTriageMessage(result);
    try {
      await sendMessage(config.channelJid, message);
      logger.info(
        { alertId: alert.id, severity: alert.severity, source: alert.source },
        'Alert triaged and posted',
      );
    } catch (err) {
      logger.error({ alertId: alert.id, err }, 'Failed to post alert');
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, alertId: alert.id, severity: alert.severity }));
  });

  server.listen(config.port, () => {
    logger.info({ port: config.port }, 'Sentry agent webhook server started');
    console.log(`\n  Sentry agent listening on port ${config.port}`);
    console.log(`  Endpoints: /webhook/sentry, /webhook/uptimerobot, /webhook/generic\n`);
  });

  return server;
}

/**
 * Load auto-fix rules from disk.
 */
function loadAutoFixes(): AutoFix[] {
  const fixesPath = path.join(DATA_DIR, 'sentry-autofixes.json');
  if (!fs.existsSync(fixesPath)) return [];

  try {
    return JSON.parse(fs.readFileSync(fixesPath, 'utf-8'));
  } catch (err) {
    logger.warn({ err }, 'Failed to load auto-fixes');
    return [];
  }
}
