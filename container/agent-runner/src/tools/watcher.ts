// Watcher — health check logic, state persistence, alert computation,
// routing (severity classification, quiet hours, escalation), and prompt templates.
// Cross-bot coordination: dependency map, maintenance mode, correlation, fleet status, diagnostics.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

import { BOTS } from './config.js';
import type { BotStatusJson } from './observe.js';
import { botStatus } from './observe.js';
import type { SshExecutor } from './ssh.js';

// ─── Types ──────────────────────────────────────────────

export type HealthState = 'healthy' | 'degraded' | 'down' | 'unreachable' | 'unknown';

export type SeverityLevel = 'critical' | 'warning' | 'info';

export type FleetStatus = 'all-healthy' | 'partial-degraded' | 'fleet-down' | 'maintenance';

export interface MaintenanceMode {
  enabled: boolean;
  reason: string;
  startedAt: string;  // ISO timestamp
  expiresAt: string;  // ISO timestamp
}

export interface BotHealthRecord {
  state: HealthState;
  previousState: HealthState;
  lastStateChange: string; // ISO timestamp
  lastCheckAt: string; // ISO timestamp
  consecutiveFailures: number;
  lastAlertAt: string | null; // ISO timestamp or null
  crashLoopCount: number;
  autoFixAttempts: number;
  autoFixWindowStart: string | null; // ISO timestamp or null
  // Escalation tracking (T2)
  lastCriticalAlertAt: string | null; // ISO timestamp or null
  criticalAlertAcknowledged: boolean;
  escalationCount: number;
  lastEscalationAt: string | null; // ISO timestamp or null
  // Maintenance mode (cross-bot-coordination T2)
  maintenance: MaintenanceMode | null;
}

export interface FleetState {
  status: FleetStatus;
  lastCorrelatedEvent: string | null; // ISO timestamp or null
  lastUpdated: string; // ISO timestamp
}

export interface HealthStateFile {
  [bot: string]: BotHealthRecord | FleetState;
}

// Type guard for fleet state
export function isFleetState(record: BotHealthRecord | FleetState): record is FleetState {
  return 'status' in record && !('state' in record);
}

// Type guard for bot health record
export function isBotHealthRecord(record: BotHealthRecord | FleetState): record is BotHealthRecord {
  return 'state' in record;
}

// Helper to get just bot records (excluding fleet)
export function getBotRecords(state: HealthStateFile): Record<string, BotHealthRecord> {
  const result: Record<string, BotHealthRecord> = {};
  for (const [key, value] of Object.entries(state)) {
    if (key !== 'fleet' && isBotHealthRecord(value)) {
      result[key] = value;
    }
  }
  return result;
}

// Helper to get fleet state
export function getFleetState(state: HealthStateFile): FleetState | null {
  const fleet = state['fleet'];
  if (fleet && isFleetState(fleet)) return fleet;
  return null;
}

export interface WatcherConfig {
  checkIntervalMs: number;
  cooldownMs: number;
  digestCron: string;
  alertChannelJid: string;
  consecutiveFailuresBeforeAlert: number;
}

export interface Alert {
  bot: string;
  type: 'alert' | 'recovery';
  from: HealthState;
  to: HealthState;
  message: string;
  suggestedAction: string;
}

export interface FleetAlert {
  type: 'correlated';
  dependency: string;
  dependencyName: string;
  affectedBots: string[];
  hypothesis: string;
  diagnosticResults?: DiagnosticResults;
  message: string;
}

export type GateDecision = 'skip' | 'invoke';

export interface WatcherCheckResult {
  gate: GateDecision;
  alerts: Alert[];
  recoveries: Alert[];
  fleetAlerts: FleetAlert[];
  unchanged: Array<{ bot: string; state: HealthState }>;
  fleetStatus: FleetStatus;
  maintenanceNotifications: MaintenanceNotification[];
  checkedAt: string;
}

export interface MaintenanceNotification {
  bot: string;
  type: 'expired' | 'expiring-soon';
  message: string;
}

// ─── Dependency Types (cross-bot-coordination T1) ────────

export interface DiagnosticConfig {
  pingHosts?: string[];
  dnsCheck?: string;
  gatewayCheck?: boolean;
}

export interface Dependency {
  id: string;
  name: string;
  description: string;
  bots: string[];
  diagnostics: DiagnosticConfig;
}

export interface DependencyMap {
  dependencies: Dependency[];
}

// ─── Diagnostic Types (cross-bot-coordination T7) ────────

export interface PingResult {
  host: string;
  ok: boolean;
  latencyMs?: number;
}

export interface DiagnosticResults {
  pingResults: PingResult[];
  dnsOk: boolean | null;  // null if not checked
  gatewayOk: boolean | null;  // null if not checked
  summary: string;
}

// ─── Routing Types (T1) ────────────────────────────────

export interface SeverityMapping {
  alertType: string;
  toState?: string;
  severity: SeverityLevel;
}

export interface ChannelMap {
  critical: string;
  warning: string;
  info: string;
}

export interface AlertFormatConfig {
  emoji: string;
  prefix: string;
  includeTimestamp: boolean;
  includeSuggestedAction: boolean;
}

export interface QuietHoursConfig {
  enabled: boolean;
  start: string; // "HH:MM"
  end: string;   // "HH:MM"
  timezone: string;
  suppressedSeverities: SeverityLevel[];
}

export interface EscalationConfig {
  enabled: boolean;
  windowMinutes: number;
  maxEscalations: number;
  escalatedEmoji: string;
  escalatedPrefix: string;
}

export interface RoutingConfig {
  version: number;
  severity: {
    mappings: SeverityMapping[];
    default: SeverityLevel;
  };
  channels: ChannelMap;
  formatting: Record<SeverityLevel, AlertFormatConfig>;
  quietHours: QuietHoursConfig;
  escalation: EscalationConfig;
}

export interface EscalationAction {
  bot: string;
  elapsedMinutes: number;
  escalationCount: number;
}

// ─── Defaults ───────────────────────────────────────────

const DEFAULT_CONFIG: WatcherConfig = {
  checkIntervalMs: 300000,
  cooldownMs: 1800000,
  digestCron: '0 8 * * *',
  alertChannelJid: 'slack:D0AM0RZ7HB2',
  consecutiveFailuresBeforeAlert: 2,
};

export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  version: 1,
  severity: {
    mappings: [
      { alertType: 'state-transition', toState: 'down', severity: 'critical' },
      { alertType: 'state-transition', toState: 'unreachable', severity: 'critical' },
      { alertType: 'escalation', severity: 'critical' },
      { alertType: 'auto-fix-failed', severity: 'critical' },
      { alertType: 'state-transition', toState: 'degraded', severity: 'warning' },
      { alertType: 'proposal', severity: 'warning' },
      { alertType: 'crash-loop', severity: 'warning' },
      { alertType: 'recovery', severity: 'info' },
      { alertType: 'auto-fix-success', severity: 'info' },
      { alertType: 'daily-digest', severity: 'info' },
    ],
    default: 'critical',
  },
  channels: {
    critical: 'slack:D0AM0RZ7HB2',
    warning: 'slack:D0AM0RZ7HB2',
    info: 'slack:C0AJ4J9H9L1',
  },
  formatting: {
    critical: {
      emoji: '\u{1F534}',
      prefix: 'CRITICAL',
      includeTimestamp: true,
      includeSuggestedAction: true,
    },
    warning: {
      emoji: '\u{1F7E1}',
      prefix: 'WARNING',
      includeTimestamp: true,
      includeSuggestedAction: true,
    },
    info: {
      emoji: '\u{1F7E2}',
      prefix: '',
      includeTimestamp: false,
      includeSuggestedAction: false,
    },
  },
  quietHours: {
    enabled: true,
    start: '23:00',
    end: '07:00',
    timezone: 'Asia/Jerusalem',
    suppressedSeverities: ['info', 'warning'],
  },
  escalation: {
    enabled: true,
    windowMinutes: 15,
    maxEscalations: 3,
    escalatedEmoji: '\u{1F6A8}',
    escalatedPrefix: 'STILL UNRESOLVED',
  },
};

export const DEFAULT_DEPENDENCY_MAP: DependencyMap = {
  dependencies: [
    {
      id: 'xps-network',
      name: 'XPS network connectivity',
      description: 'SSH from XPS to bot hosts requires XPS to have working network',
      bots: ['db', 'nook'],
      diagnostics: {
        pingHosts: ['100.88.246.12', '192.168.68.62'],
        dnsCheck: 'google.com',
        gatewayCheck: true,
      },
    },
    {
      id: 'home-wifi',
      name: 'Home WiFi',
      description: 'ROG (Nook) connects via WiFi which is less reliable than wired',
      bots: ['nook'],
      diagnostics: {
        pingHosts: ['192.168.68.62'],
      },
    },
  ],
};

function defaultBotHealth(): BotHealthRecord {
  return {
    state: 'unknown',
    previousState: 'unknown',
    lastStateChange: new Date().toISOString(),
    lastCheckAt: new Date().toISOString(),
    consecutiveFailures: 0,
    lastAlertAt: null,
    crashLoopCount: 0,
    autoFixAttempts: 0,
    autoFixWindowStart: null,
    lastCriticalAlertAt: null,
    criticalAlertAcknowledged: false,
    escalationCount: 0,
    lastEscalationAt: null,
    maintenance: null,
  };
}

function defaultFleetState(): FleetState {
  return {
    status: 'all-healthy',
    lastCorrelatedEvent: null,
    lastUpdated: new Date().toISOString(),
  };
}

// ─── State File I/O ─────────────────────────────────────

/**
 * Read health state from a JSON file. Returns default state if file
 * is missing or corrupt. Gracefully handles old state files missing new fields.
 */
export function readHealthState(filePath: string): HealthStateFile {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return initializeHealthState();
    }
    // Backfill new fields for existing state files
    for (const bot of Object.keys(parsed)) {
      if (bot === 'fleet') continue; // fleet is a special key
      const record = parsed[bot];
      if (record.crashLoopCount === undefined) record.crashLoopCount = 0;
      if (record.autoFixAttempts === undefined) record.autoFixAttempts = 0;
      if (record.autoFixWindowStart === undefined) record.autoFixWindowStart = null;
      // Backfill escalation tracking fields (T2)
      if (record.lastCriticalAlertAt === undefined) record.lastCriticalAlertAt = null;
      if (record.criticalAlertAcknowledged === undefined) record.criticalAlertAcknowledged = false;
      if (record.escalationCount === undefined) record.escalationCount = 0;
      if (record.lastEscalationAt === undefined) record.lastEscalationAt = null;
      // Backfill maintenance mode (cross-bot-coordination T2)
      if (record.maintenance === undefined) record.maintenance = null;
    }
    // Backfill fleet state if missing
    if (!parsed.fleet) {
      parsed.fleet = defaultFleetState();
    }
    return parsed as HealthStateFile;
  } catch {
    return initializeHealthState();
  }
}

/**
 * Write health state atomically (write tmp + rename).
 */
export function writeHealthState(filePath: string, state: HealthStateFile): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
  fs.renameSync(tmpPath, filePath);
}

/**
 * Initialize health state with all known bots in 'unknown' state.
 */
export function initializeHealthState(): HealthStateFile {
  const state: HealthStateFile = {};
  for (const botKey of Object.keys(BOTS)) {
    state[botKey] = defaultBotHealth();
  }
  state.fleet = defaultFleetState();
  return state;
}

/**
 * Read watcher config. Returns defaults if missing or corrupt.
 */
export function readWatcherConfig(filePath: string): WatcherConfig {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    // Auto-create config with defaults if missing or corrupt
    const defaults = { ...DEFAULT_CONFIG };
    try {
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(defaults, null, 2));
    } catch { /* best-effort */ }
    return defaults;
  }
}

// ─── Routing Config I/O (T1) ────────────────────────────

/**
 * Validate that a routing config object has the required structure.
 */
function validateRoutingConfig(obj: unknown): obj is RoutingConfig {
  if (typeof obj !== 'object' || obj === null) return false;
  const c = obj as Record<string, unknown>;
  if (typeof c.version !== 'number') return false;
  if (typeof c.severity !== 'object' || c.severity === null) return false;
  const sev = c.severity as Record<string, unknown>;
  if (!Array.isArray(sev.mappings)) return false;
  if (typeof sev.default !== 'string') return false;
  if (typeof c.channels !== 'object' || c.channels === null) return false;
  const ch = c.channels as Record<string, unknown>;
  if (typeof ch.critical !== 'string' || typeof ch.warning !== 'string' || typeof ch.info !== 'string') return false;
  if (typeof c.formatting !== 'object' || c.formatting === null) return false;
  if (typeof c.quietHours !== 'object' || c.quietHours === null) return false;
  if (typeof c.escalation !== 'object' || c.escalation === null) return false;
  return true;
}

/**
 * Read routing config from a JSON file. Returns default config if file
 * is missing, corrupt, or fails validation.
 */
export function readRoutingConfig(filePath: string): RoutingConfig {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!validateRoutingConfig(parsed)) {
      return { ...DEFAULT_ROUTING_CONFIG };
    }
    return parsed;
  } catch {
    return { ...DEFAULT_ROUTING_CONFIG };
  }
}

// ─── Dependency Map I/O (cross-bot-coordination T1) ─────

/**
 * Validate a dependency object has required fields.
 */
function validateDependency(dep: unknown): dep is Dependency {
  if (typeof dep !== 'object' || dep === null) return false;
  const d = dep as Record<string, unknown>;
  if (typeof d.id !== 'string') return false;
  if (typeof d.name !== 'string') return false;
  if (typeof d.description !== 'string') return false;
  if (!Array.isArray(d.bots) || d.bots.length === 0) return false;
  for (const b of d.bots) {
    if (typeof b !== 'string') return false;
  }
  if (typeof d.diagnostics !== 'object' || d.diagnostics === null) return false;
  return true;
}

/**
 * Read dependency map from a JSON file. Returns empty map if file
 * is missing or corrupt (graceful degradation — correlation is skipped).
 */
export function readDependencies(filePath: string): DependencyMap {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return { dependencies: [] };
    }
    if (!Array.isArray(parsed.dependencies)) {
      return { dependencies: [] };
    }
    const valid: Dependency[] = [];
    for (const dep of parsed.dependencies) {
      if (validateDependency(dep)) {
        valid.push(dep);
      }
    }
    return { dependencies: valid };
  } catch {
    return { dependencies: [] };
  }
}

// ─── Health Classification ──────────────────────────────

const HEALTHY_UPTIME_THRESHOLD = 300; // 5 minutes in seconds

/**
 * Classify a bot's health based on its status JSON.
 */
export function classifyHealth(status: BotStatusJson): HealthState {
  if (!status.ssh_ok) return 'unreachable';
  if (status.state === 'not_found' || status.state === 'stopped') return 'down';
  if (status.state === 'unknown') return 'unreachable';
  if (status.state === 'restarting') return 'degraded';
  if (status.state === 'running') {
    if (status.uptime_seconds !== null && status.uptime_seconds < HEALTHY_UPTIME_THRESHOLD) {
      return 'degraded';
    }
    return 'healthy';
  }
  return 'unknown';
}

// ─── Alert Logic ────────────────────────────────────────

const STATE_SEVERITY: Record<HealthState, number> = {
  healthy: 0,
  degraded: 1,
  down: 2,
  unreachable: 3,
  unknown: -1,
};

/**
 * Compute alerts based on state transitions, cooldown, and consecutive failures.
 * Also tracks crash-loop count and carries forward policy tracking fields.
 */
export function computeAlerts(
  previous: HealthStateFile,
  current: Record<string, HealthState>,
  config: WatcherConfig,
  now: Date = new Date(),
): { alerts: Alert[]; recoveries: Alert[]; updatedState: HealthStateFile } {
  const alerts: Alert[] = [];
  const recoveries: Alert[] = [];
  const updatedState: HealthStateFile = {};
  const nowIso = now.toISOString();
  const nowMs = now.getTime();

  for (const [bot, newState] of Object.entries(current)) {
    const prevRaw = previous[bot];
    const prev = (prevRaw && isBotHealthRecord(prevRaw)) ? prevRaw : defaultBotHealth();
    const record: BotHealthRecord = { ...prev, lastCheckAt: nowIso };

    const isWorse = STATE_SEVERITY[newState] > STATE_SEVERITY[prev.state] && prev.state !== 'unknown';
    const isBetter = STATE_SEVERITY[newState] < STATE_SEVERITY[prev.state] && prev.state !== 'unknown';
    const stateChanged = newState !== prev.state;

    if (stateChanged) {
      record.previousState = prev.state;
      record.state = newState;
      record.lastStateChange = nowIso;

      if (newState === 'healthy' || newState === 'degraded') {
        record.consecutiveFailures = 0;
      }
    } else {
      record.state = newState;
    }

    // Count consecutive failures for down/unreachable
    if (newState === 'down' || newState === 'unreachable') {
      record.consecutiveFailures = prev.consecutiveFailures + 1;
    } else {
      record.consecutiveFailures = 0;
    }

    // Track crash-loop count: increment when degraded, reset otherwise
    if (newState === 'degraded') {
      record.crashLoopCount = (prev.crashLoopCount ?? 0) + 1;
    } else {
      record.crashLoopCount = 0;
    }

    // Reset policy tracking on recovery
    if (newState === 'healthy') {
      record.autoFixAttempts = 0;
      record.autoFixWindowStart = null;
    } else {
      // Carry forward policy tracking fields
      record.autoFixAttempts = prev.autoFixAttempts ?? 0;
      record.autoFixWindowStart = prev.autoFixWindowStart ?? null;
    }

    // Determine if we should alert
    const cooldownElapsed = !prev.lastAlertAt ||
      (nowMs - new Date(prev.lastAlertAt).getTime()) >= config.cooldownMs;

    if (isWorse && record.consecutiveFailures >= config.consecutiveFailuresBeforeAlert && cooldownElapsed) {
      const botName = BOTS[bot]?.name ?? bot;
      alerts.push({
        bot,
        type: 'alert',
        from: prev.state,
        to: newState,
        message: `${botName} is ${newState} (was ${prev.state})`,
        suggestedAction: newState === 'unreachable'
          ? `Check SSH connectivity to ${BOTS[bot]?.sshTarget ?? 'host'}`
          : `X check ${botName} logs`,
      });
      record.lastAlertAt = nowIso;
    } else if (isBetter && (prev.state === 'down' || prev.state === 'unreachable')) {
      const botName = BOTS[bot]?.name ?? bot;
      recoveries.push({
        bot,
        type: 'recovery',
        from: prev.state,
        to: newState,
        message: `${botName} is back (was ${prev.state})`,
        suggestedAction: 'No action needed',
      });
      record.lastAlertAt = nowIso;
    }

    updatedState[bot] = record;
  }

  return { alerts, recoveries, updatedState };
}

// ─── Maintenance Mode (cross-bot-coordination T5) ───────

/**
 * Filter out alerts for bots in active maintenance mode.
 * Checks expiry — if expiresAt has passed, auto-clears maintenance and generates notification.
 * Generates reminder when within 5 minutes of expiry.
 */
export function filterMaintenanceMode(
  alerts: Alert[],
  healthState: HealthStateFile,
  now: Date = new Date(),
): { filteredAlerts: Alert[]; notifications: MaintenanceNotification[] } {
  const notifications: MaintenanceNotification[] = [];
  const nowMs = now.getTime();
  const FIVE_MINUTES_MS = 5 * 60 * 1000;

  const botRecords = getBotRecords(healthState);

  for (const [bot, record] of Object.entries(botRecords)) {
    if (!record.maintenance) continue;

    const expiresAtMs = new Date(record.maintenance.expiresAt).getTime();

    if (nowMs >= expiresAtMs) {
      // Maintenance has expired — auto-clear
      record.maintenance = null;
      const botName = BOTS[bot]?.name ?? bot;
      notifications.push({
        bot,
        type: 'expired',
        message: `${botName} maintenance mode has expired. Resuming monitoring.`,
      });
    } else if (expiresAtMs - nowMs <= FIVE_MINUTES_MS) {
      // Within 5 minutes of expiry — reminder
      const remainingMin = Math.ceil((expiresAtMs - nowMs) / 60000);
      const botName = BOTS[bot]?.name ?? bot;
      notifications.push({
        bot,
        type: 'expiring-soon',
        message: `${botName} maintenance mode expires in ${remainingMin} minute${remainingMin === 1 ? '' : 's'}.`,
      });
    }
  }

  // Filter out alerts for bots still in maintenance mode
  const filteredAlerts = alerts.filter(alert => {
    const record = botRecords[alert.bot];
    if (!record) return true;
    return !record.maintenance;
  });

  return { filteredAlerts, notifications };
}

// ─── Alert Correlation (cross-bot-coordination T4) ──────

/**
 * Correlate alerts by shared dependency. If all bots sharing a dependency
 * are unreachable, replace individual alerts with a single fleet alert.
 */
export function correlateAlerts(
  alerts: Alert[],
  dependencies: DependencyMap,
): { individualAlerts: Alert[]; fleetAlerts: FleetAlert[] } {
  if (dependencies.dependencies.length === 0) {
    return { individualAlerts: alerts, fleetAlerts: [] };
  }

  const fleetAlerts: FleetAlert[] = [];
  const consumedBots = new Set<string>();

  for (const dep of dependencies.dependencies) {
    // Only correlate dependencies with multiple bots
    if (dep.bots.length < 2) continue;

    // Check if all bots in this dependency are unreachable in current alerts
    const unreachableInDep = alerts.filter(
      a => dep.bots.includes(a.bot) && a.to === 'unreachable',
    );

    if (unreachableInDep.length === dep.bots.length) {
      // All bots in this dependency are unreachable — correlate
      fleetAlerts.push({
        type: 'correlated',
        dependency: dep.id,
        dependencyName: dep.name,
        affectedBots: [...dep.bots],
        hypothesis: `All bots on ${dep.name} are unreachable — likely infrastructure issue`,
        message: `Fleet alert: ${dep.name} — all bots unreachable (${dep.bots.map(b => BOTS[b]?.name ?? b).join(', ')})`,
      });

      for (const bot of dep.bots) {
        consumedBots.add(bot);
      }
    }
  }

  // Return remaining individual alerts (not consumed by correlation)
  const individualAlerts = alerts.filter(a => !consumedBots.has(a.bot));

  return { individualAlerts, fleetAlerts };
}

// ─── Fleet Status (cross-bot-coordination T6) ───────────

/**
 * Compute fleet-level health status from per-bot health states.
 * Excludes bots in maintenance mode.
 */
export function computeFleetStatus(
  healthState: HealthStateFile,
): FleetStatus {
  const botRecords = getBotRecords(healthState);
  const activeBots: BotHealthRecord[] = [];

  for (const record of Object.values(botRecords)) {
    if (!record.maintenance) {
      activeBots.push(record);
    }
  }

  if (activeBots.length === 0) {
    return 'maintenance';
  }

  const allHealthy = activeBots.every(b => b.state === 'healthy');
  if (allHealthy) return 'all-healthy';

  const allDown = activeBots.every(b => b.state === 'down' || b.state === 'unreachable');
  if (allDown) return 'fleet-down';

  return 'partial-degraded';
}

// ─── Coordinated Diagnostics (cross-bot-coordination T7) ─

/**
 * Run a single ping check with timeout.
 */
export function pingHost(host: string, timeoutMs: number = 3000): PingResult {
  try {
    const timeoutSec = Math.ceil(timeoutMs / 1000);
    execSync(`ping -c 1 -W ${timeoutSec} ${host}`, {
      timeout: timeoutMs + 1000,
      stdio: 'pipe',
    });
    return { host, ok: true };
  } catch {
    return { host, ok: false };
  }
}

/**
 * Check DNS resolution for a hostname.
 */
export function checkDns(hostname: string, timeoutMs: number = 3000): boolean {
  try {
    execSync(`getent hosts ${hostname}`, {
      timeout: timeoutMs,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check default gateway reachability.
 */
export function checkGateway(timeoutMs: number = 3000): boolean {
  try {
    // Get default gateway
    const gatewayOutput = execSync("ip route | grep default | awk '{print $3}'", {
      timeout: timeoutMs,
      stdio: 'pipe',
    }).toString().trim();

    if (!gatewayOutput) return false;

    const timeoutSec = Math.ceil(timeoutMs / 1000);
    execSync(`ping -c 1 -W ${timeoutSec} ${gatewayOutput}`, {
      timeout: timeoutMs + 1000,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run coordinated diagnostic checks for a dependency.
 * All checks run from XPS. Total timeout: 15 seconds.
 */
export function runCoordinatedDiagnostics(
  diagnostics: DiagnosticConfig,
  options?: {
    pingFn?: (host: string, timeoutMs: number) => PingResult;
    dnsFn?: (hostname: string, timeoutMs: number) => boolean;
    gatewayFn?: (timeoutMs: number) => boolean;
  },
): DiagnosticResults {
  const ping = options?.pingFn ?? pingHost;
  const dns = options?.dnsFn ?? checkDns;
  const gateway = options?.gatewayFn ?? checkGateway;

  const pingResults: PingResult[] = [];
  let dnsOk: boolean | null = null;
  let gatewayOk: boolean | null = null;

  // Run ping checks
  if (diagnostics.pingHosts) {
    for (const host of diagnostics.pingHosts) {
      pingResults.push(ping(host, 3000));
    }
  }

  // Run DNS check
  if (diagnostics.dnsCheck) {
    dnsOk = dns(diagnostics.dnsCheck, 3000);
  }

  // Run gateway check
  if (diagnostics.gatewayCheck) {
    gatewayOk = gateway(3000);
  }

  // Build summary
  const summary = formatDiagnosticSummary(pingResults, dnsOk, gatewayOk);

  return { pingResults, dnsOk, gatewayOk, summary };
}

/**
 * Format diagnostic results into a human-readable summary.
 */
export function formatDiagnosticSummary(
  pingResults: PingResult[],
  dnsOk: boolean | null,
  gatewayOk: boolean | null,
): string {
  const parts: string[] = [];

  for (const pr of pingResults) {
    parts.push(`Ping to ${pr.host}: ${pr.ok ? 'ok' : 'failed'}.`);
  }

  if (dnsOk !== null) {
    parts.push(`DNS: ${dnsOk ? 'ok' : 'failed'}.`);
  }

  if (gatewayOk !== null) {
    parts.push(`Gateway: ${gatewayOk ? 'ok' : 'failed'}.`);
  }

  // Generate hypothesis
  const allPingsFailed = pingResults.length > 0 && pingResults.every(r => !r.ok);
  const allFailed = allPingsFailed && dnsOk === false;

  if (allFailed) {
    parts.push('XPS appears to have no internet connectivity.');
  } else if (allPingsFailed && dnsOk === null) {
    parts.push('All pings failed — XPS may have connectivity issues.');
  } else if (pingResults.some(r => !r.ok) && pingResults.some(r => r.ok)) {
    parts.push('Some hosts unreachable — issue may be host-specific.');
  } else if (pingResults.length > 0 && pingResults.every(r => r.ok)) {
    parts.push('XPS network OK — issue may be host-specific.');
  }

  return parts.join(' ');
}

// ─── Severity Classification (T4) ──────────────────────

/**
 * Classify the severity of an alert based on routing config mappings.
 * Pure deterministic lookup — first match wins.
 */
export function classifySeverity(
  alertType: string,
  context: Record<string, unknown>,
  routingConfig: RoutingConfig,
): SeverityLevel {
  for (const mapping of routingConfig.severity.mappings) {
    if (mapping.alertType !== alertType) continue;
    // If mapping has a toState constraint, check it
    if (mapping.toState !== undefined) {
      if (context.toState !== mapping.toState) continue;
    }
    return mapping.severity;
  }
  return routingConfig.severity.default;
}

// ─── Quiet Hours (T5) ──────────────────────────────────

/**
 * Parse a "HH:MM" string into { hours, minutes }.
 */
function parseTime(time: string): { hours: number; minutes: number } {
  const [h, m] = time.split(':').map(Number);
  return { hours: h ?? 0, minutes: m ?? 0 };
}

/**
 * Get current time in the given timezone as { hours, minutes }.
 * Falls back to UTC if timezone is invalid.
 */
function getCurrentTimeInTimezone(
  timezone: string,
  now: Date = new Date(),
): { hours: number; minutes: number } {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    });
    const parts = formatter.formatToParts(now);
    const hours = Number(parts.find(p => p.type === 'hour')?.value ?? 0);
    const minutes = Number(parts.find(p => p.type === 'minute')?.value ?? 0);
    return { hours, minutes };
  } catch {
    // Invalid timezone — fall back to UTC
    return { hours: now.getUTCHours(), minutes: now.getUTCMinutes() };
  }
}

/**
 * Convert { hours, minutes } to total minutes since midnight.
 */
function toMinutesSinceMidnight(t: { hours: number; minutes: number }): number {
  return t.hours * 60 + t.minutes;
}

/**
 * Check if the current time falls within configured quiet hours.
 * Handles overnight windows (start > end crosses midnight).
 */
export function isQuietHours(config: QuietHoursConfig, now?: Date): boolean {
  if (!config.enabled) return false;
  const current = getCurrentTimeInTimezone(config.timezone, now);
  const start = parseTime(config.start);
  const end = parseTime(config.end);
  const currentMin = toMinutesSinceMidnight(current);
  const startMin = toMinutesSinceMidnight(start);
  const endMin = toMinutesSinceMidnight(end);

  if (startMin <= endMin) {
    // Same-day window: e.g. 09:00 - 17:00
    return currentMin >= startMin && currentMin < endMin;
  } else {
    // Overnight window: e.g. 23:00 - 07:00
    return currentMin >= startMin || currentMin < endMin;
  }
}

/**
 * Determine if an alert should be suppressed during quiet hours.
 * Returns true only if quiet hours are active AND severity is in suppressedSeverities.
 */
export function shouldSuppress(
  severity: SeverityLevel,
  config: QuietHoursConfig,
  now?: Date,
): boolean {
  if (!isQuietHours(config, now)) return false;
  return config.suppressedSeverities.includes(severity);
}

// ─── Channel Routing (T6) ──────────────────────────────

/**
 * Route an alert to the appropriate channel based on severity.
 */
export function routeAlert(severity: SeverityLevel, channels: ChannelMap): string {
  return channels[severity];
}

/**
 * Format an alert message with severity-specific emoji and prefix.
 */
export function formatAlert(
  message: string,
  severity: SeverityLevel,
  formatting: Record<SeverityLevel, AlertFormatConfig>,
  escalated: boolean = false,
  escalationConfig?: EscalationConfig,
): string {
  if (escalated && escalationConfig) {
    return `${escalationConfig.escalatedEmoji} ${escalationConfig.escalatedPrefix} — ${message}`;
  }
  const fmt = formatting[severity];
  if (!fmt) return message;
  if (fmt.prefix) {
    return `${fmt.emoji} ${fmt.prefix} — ${message}`;
  }
  // Info severity: emoji only, no prefix
  return `${fmt.emoji} ${message}`;
}

// ─── Escalation Logic (T7, T8) ─────────────────────────

/**
 * Check all bots for pending critical alert escalations.
 * Returns escalation actions for bots that need re-alerting.
 */
export function checkEscalations(
  healthState: HealthStateFile,
  routingConfig: RoutingConfig,
  now: Date = new Date(),
): EscalationAction[] {
  if (!routingConfig.escalation.enabled) return [];

  const actions: EscalationAction[] = [];
  const windowMs = routingConfig.escalation.windowMinutes * 60 * 1000;
  const botRecords = getBotRecords(healthState);

  for (const [bot, record] of Object.entries(botRecords)) {
    if (!record.lastCriticalAlertAt) continue;
    if (record.criticalAlertAcknowledged) continue;
    if (record.escalationCount >= routingConfig.escalation.maxEscalations) continue;

    const alertTime = new Date(record.lastCriticalAlertAt).getTime();
    const elapsed = now.getTime() - alertTime;

    // For escalation, we also need to account for time since last escalation
    const lastEscTime = record.lastEscalationAt
      ? new Date(record.lastEscalationAt).getTime()
      : alertTime;
    const elapsedSinceLastAction = now.getTime() - lastEscTime;

    if (elapsedSinceLastAction >= windowMs) {
      actions.push({
        bot,
        elapsedMinutes: Math.round(elapsed / 60000),
        escalationCount: record.escalationCount,
      });
    }
  }

  return actions;
}

/**
 * Mark that a critical alert was sent for a bot.
 * Sets lastCriticalAlertAt and resets escalation tracking.
 */
export function markCriticalAlert(
  bot: string,
  healthState: HealthStateFile,
  timestamp: string,
): void {
  const record = healthState[bot];
  if (!record || !isBotHealthRecord(record)) return;
  record.lastCriticalAlertAt = timestamp;
  record.criticalAlertAcknowledged = false;
  record.escalationCount = 0;
  record.lastEscalationAt = null;
}

/**
 * Mark that an escalation was sent for a bot.
 * Increments escalationCount and sets lastEscalationAt.
 */
export function markEscalation(
  bot: string,
  healthState: HealthStateFile,
  timestamp: string,
): void {
  const record = healthState[bot];
  if (!record || !isBotHealthRecord(record)) return;
  record.escalationCount += 1;
  record.lastEscalationAt = timestamp;
}

/**
 * Clear escalation state for a bot (called on recovery).
 * Resets all escalation tracking fields.
 */
export function clearEscalation(
  bot: string,
  healthState: HealthStateFile,
): void {
  const record = healthState[bot];
  if (!record || !isBotHealthRecord(record)) return;
  record.lastCriticalAlertAt = null;
  record.criticalAlertAcknowledged = true;
  record.escalationCount = 0;
  record.lastEscalationAt = null;
}

// ─── Maintenance Mode Set/Clear (cross-bot-coordination T3) ─

/**
 * Set maintenance mode for a bot or all bots.
 */
export function setMaintenanceMode(
  healthState: HealthStateFile,
  bot: string | undefined,
  durationMinutes: number = 60,
  reason: string = '',
  now: Date = new Date(),
): string {
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + durationMinutes * 60 * 1000).toISOString();
  const maintenance: MaintenanceMode = {
    enabled: true,
    reason,
    startedAt: nowIso,
    expiresAt,
  };

  const botRecords = getBotRecords(healthState);

  if (bot) {
    const record = botRecords[bot];
    if (!record) return `Error: unknown bot "${bot}". Valid bots: ${Object.keys(botRecords).join(', ')}`;
    record.maintenance = maintenance;
    const botName = BOTS[bot]?.name ?? bot;
    return `Maintenance mode set for ${botName} until ${expiresAt} (${durationMinutes} min).${reason ? ` Reason: ${reason}` : ''}`;
  } else {
    // Fleet-wide
    for (const record of Object.values(botRecords)) {
      record.maintenance = maintenance;
    }
    return `Maintenance mode set for all bots until ${expiresAt} (${durationMinutes} min).${reason ? ` Reason: ${reason}` : ''}`;
  }
}

/**
 * Clear maintenance mode for a bot or all bots.
 */
export function clearMaintenanceMode(
  healthState: HealthStateFile,
  bot: string | undefined,
): string {
  const botRecords = getBotRecords(healthState);

  if (bot) {
    const record = botRecords[bot];
    if (!record) return `Error: unknown bot "${bot}". Valid bots: ${Object.keys(botRecords).join(', ')}`;
    record.maintenance = null;
    const botName = BOTS[bot]?.name ?? bot;
    return `Maintenance mode cleared for ${botName}. Monitoring resumed.`;
  } else {
    for (const record of Object.values(botRecords)) {
      record.maintenance = null;
    }
    return 'Maintenance mode cleared for all bots. Monitoring resumed.';
  }
}

/**
 * Get maintenance mode status for all bots.
 */
export function getMaintenanceStatus(
  healthState: HealthStateFile,
  now: Date = new Date(),
): string {
  const botRecords = getBotRecords(healthState);
  const lines: string[] = [];
  let anyActive = false;

  for (const [bot, record] of Object.entries(botRecords)) {
    const botName = BOTS[bot]?.name ?? bot;
    if (record.maintenance) {
      anyActive = true;
      const expiresAt = new Date(record.maintenance.expiresAt);
      const remainingMs = expiresAt.getTime() - now.getTime();
      const remainingMin = Math.max(0, Math.ceil(remainingMs / 60000));
      const expired = remainingMs <= 0;
      if (expired) {
        lines.push(`${botName}: maintenance mode EXPIRED (was set: ${record.maintenance.reason || 'no reason'})`);
      } else {
        lines.push(`${botName}: in maintenance mode (${remainingMin} min remaining). Reason: ${record.maintenance.reason || 'none'}`);
      }
    } else {
      lines.push(`${botName}: normal monitoring`);
    }
  }

  if (!anyActive) {
    return 'No active maintenance modes. All bots being monitored normally.';
  }

  return lines.join('\n');
}

// ─── Watcher Check (main entry point) ───────────────────

/**
 * Run a full health check cycle on all managed bots.
 * Reads state, checks each bot, computes alerts, runs maintenance filter,
 * runs correlation, computes fleet status, writes state.
 */

// ─── Deterministic Gate ─────────────────────────────────

/**
 * Determine whether the LLM needs to be involved in this health check cycle.
 * Returns 'skip' when all bots are healthy with no state transitions,
 * no maintenance expirations pending, and no escalations due.
 * Returns 'invoke' otherwise.
 */
export function computeGateDecision(
  result: {
    alerts: Alert[];
    recoveries: Alert[];
    fleetAlerts: FleetAlert[];
    maintenanceNotifications: MaintenanceNotification[];
  },
  healthState: HealthStateFile,
  routingConfig: RoutingConfig | null,
): GateDecision {
  if (result.alerts.length > 0) return 'invoke';
  if (result.recoveries.length > 0) return 'invoke';
  if (result.fleetAlerts.length > 0) return 'invoke';
  if (result.maintenanceNotifications.length > 0) return 'invoke';

  // Check for pending escalations
  if (routingConfig) {
    const escalations = checkEscalations(healthState, routingConfig);
    if (escalations.length > 0) return 'invoke';
  }

  return 'skip';
}

export async function watcherCheck(
  ssh: SshExecutor,
  statePath: string,
  configPath: string,
  dependenciesPath?: string,
): Promise<WatcherCheckResult> {
  const config = readWatcherConfig(configPath);
  const previousState = readHealthState(statePath);
  const now = new Date();

  // Check each bot
  const currentStates: Record<string, HealthState> = {};
  for (const botKey of Object.keys(BOTS)) {
    try {
      const raw = await botStatus(botKey, ssh, { format: 'json' });
      const parsed: BotStatusJson = JSON.parse(raw);
      currentStates[botKey] = classifyHealth(parsed);
    } catch {
      currentStates[botKey] = 'unreachable';
    }
  }

  // Compute alerts
  const { alerts: rawAlerts, recoveries, updatedState } = computeAlerts(
    previousState, currentStates, config, now,
  );

  // Preserve fleet state from previous
  const prevFleet = getFleetState(previousState);
  if (prevFleet) {
    updatedState.fleet = prevFleet;
  } else {
    updatedState.fleet = defaultFleetState();
  }

  // Step 1: Filter maintenance mode
  const { filteredAlerts, notifications: maintenanceNotifications } = filterMaintenanceMode(
    rawAlerts, updatedState, now,
  );

  // Step 2: Correlate alerts
  let individualAlerts = filteredAlerts;
  let fleetAlerts: FleetAlert[] = [];

  if (dependenciesPath) {
    const deps = readDependencies(dependenciesPath);
    if (deps.dependencies.length > 0) {
      const corr = correlateAlerts(filteredAlerts, deps);
      individualAlerts = corr.individualAlerts;
      fleetAlerts = corr.fleetAlerts;

      // Step 3: Run diagnostics for fleet alerts
      for (const fa of fleetAlerts) {
        const dep = deps.dependencies.find(d => d.id === fa.dependency);
        if (dep?.diagnostics) {
          fa.diagnosticResults = runCoordinatedDiagnostics(dep.diagnostics);
          fa.message += ` Network self-check: ${fa.diagnosticResults.summary}`;
        }
      }

      // Update fleet state with correlated event
      if (fleetAlerts.length > 0) {
        const fleet = updatedState.fleet as FleetState;
        fleet.lastCorrelatedEvent = now.toISOString();
      }
    }
  }

  // Step 4: Compute fleet status
  const fleetStatus = computeFleetStatus(updatedState);
  const fleet = updatedState.fleet as FleetState;
  fleet.status = fleetStatus;
  fleet.lastUpdated = now.toISOString();

  // Write updated state
  writeHealthState(statePath, updatedState);

  // Build unchanged list
  const unchanged: Array<{ bot: string; state: HealthState }> = [];
  for (const [bot, state] of Object.entries(currentStates)) {
    if (!rawAlerts.some(a => a.bot === bot) && !recoveries.some(r => r.bot === bot)) {
      unchanged.push({ bot, state });
    }
  }

  // Compute gate decision (deterministic — no LLM needed for this)
  const routingConfigPath = path.join(path.dirname(configPath), 'routing.json');
  let routingConfigForGate: RoutingConfig | null = null;
  try {
    routingConfigForGate = readRoutingConfig(routingConfigPath);
  } catch {
    routingConfigForGate = null;
  }
  const gate = computeGateDecision(
    { alerts: individualAlerts, recoveries, fleetAlerts, maintenanceNotifications },
    updatedState,
    routingConfigForGate,
  );

  return {
    gate,
    alerts: individualAlerts,
    recoveries,
    fleetAlerts,
    unchanged,
    fleetStatus,
    maintenanceNotifications,
    checkedAt: now.toISOString(),
  };
}


// ─── Prompt Templates ───────────────────────────────────

export const HEALTH_CHECK_PROMPT = `Run a health check on all managed bots and evaluate policy rules, with alert routing based on severity and cross-bot coordination.

Steps:
1. Run watcher_check to get current health status. This returns a gate decision, fleet alerts, individual alerts, fleet status, and maintenance notifications.

**IMPORTANT — Gate check**: If the result contains \`gate: "skip"\`, ALL bots are healthy with no state changes, no pending escalations, and no maintenance expirations. Produce absolutely NO output — no message, no confirmation, no summary. Just stop. The gate has already updated the health state file.

If \`gate: "invoke"\`, continue with the steps below.
2. Load routing config from /workspace/extra/watcher/routing.json (if missing, route all alerts to operator DM).
3. Handle maintenance notifications:
   a. For "expired" notifications: send to operator DM as info-severity message.
   b. For "expiring-soon" notifications: send to operator DM as warning-severity message.
4. Check for pending escalations BEFORE processing new alerts:
   a. Read health state for each bot.
   b. For each bot with lastCriticalAlertAt set and criticalAlertAcknowledged=false:
      - If elapsed time > escalation windowMinutes AND escalationCount < maxEscalations:
      - Send an escalated alert to the critical channel with escalated formatting:
        \u{1F6A8} STILL UNRESOLVED — [Bot Name] has been [state] for [duration] with no response
      - Update escalationCount and lastEscalationAt in health state.
   c. If escalationCount >= maxEscalations, log "max escalations reached" but do not re-send.
5. For each fleet alert (correlated events):
   a. Run policy_evaluate with bot="fleet", correlated=true.
   b. The fleet alert already includes diagnostic results.
   c. Format as critical alert: \u{1F534} CRITICAL — Fleet alert: [dependency name] — [message with diagnostics]
   d. Route to operator DM.
   e. Log the correlated event in the action log.
6. For each individual alert returned by watcher_check, run policy_evaluate with the bot, from_state, and to_state.
7. For each policy decision, classify severity and route the alert:
   a. Classify severity using the routing config severity mappings:
      - Match alertType + context (toState) against mappings, first match wins
      - Alert types: "state-transition" (use toState from alert), "escalation", "crash-loop", "proposal", "auto-fix-success", "auto-fix-failed"
      - Default to "critical" if no mapping matches
   b. Check quiet hours — if severity is in suppressedSeverities and quiet hours are active:
      - Log the alert to action log with routing.suppressed=true
      - Do NOT send a Slack message
      - Skip to next alert
   c. Route to channel based on severity:
      - critical → operator DM (slack:D0AM0RZ7HB2)
      - warning → operator DM (slack:D0AM0RZ7HB2)
      - info → group channel (slack:C0AJ4J9H9L1)
   d. Format message using severity-specific formatting:
      - critical: \u{1F534} CRITICAL — [message]
      - warning: \u{1F7E1} WARNING — [message]
      - info: \u{1F7E2} [message] (no prefix)
   e. Based on the policy response:
      - If response is "auto-fix": Execute the playbook steps (docker_command restart, wait 30s, bot_status verify).
        On success: classify as "auto-fix-success" (info severity), route to group channel.
        On failure: classify as "auto-fix-failed" (critical severity), route to operator DM.
      - If response is "propose": classify as "proposal" (warning severity), route to operator DM.
      - If response is "alert-only": route based on severity classification.
   f. If severity is critical: update lastCriticalAlertAt, reset escalation tracking.
8. For recoveries:
   a. Route recovery notification as "recovery" (info severity) to the group channel.
   b. If bot had a pending critical alert: mark criticalAlertAcknowledged=true, clear escalation state.
   c. Format: \u{1F7E2} [Bot Name] is back (was [previous state])
9. Report fleet status: include in the output a brief fleet status line.
10. Report maintenance mode: include current maintenance modes in the output.
11. Log all routing decisions to the action log with routing metadata: { severity, channel, suppressed, escalated }.
12. If there are no alerts, no recoveries, no escalations, no fleet alerts, no maintenance notifications, and all bots are healthy — produce no output.

Important:
- For auto-fix, only use docker_command with action "restart". Never use edit_file or run_command in auto-fix mode.
- If auto-fix playbook fails (bot not healthy after restart), report the failure and do not retry immediately.
- Always include the policy decision context in notifications so the operator knows why this action was taken.
- Escalation re-alerts are NOT subject to cooldown suppression.
- Auto-fix success notifications are NEVER suppressed by quiet hours.
- Fleet alerts are NEVER suppressed by quiet hours (always critical).
- Maintenance notifications are NEVER suppressed.`;

export const DAILY_DIGEST_PROMPT = `Generate the daily health digest for all managed bots and route it to the group channel (info severity).

1. Run bot_status to get current state and uptime for each bot
2. Run search_logs with pattern "error|fatal|panic" (last 200 lines) to count recent errors
3. Count container restarts in last 24h by searching logs for "starting" or checking uptime patterns
4. Run list_issues to count open GitHub issues

Also check the action log at /workspace/extra/watcher/action-log.json for any auto-fix or policy actions in the last 24h.

Additionally, check the action log for any alerts that were suppressed by quiet hours since the last digest. Include a summary section grouping suppressed alerts by bot and severity.

Check the action log for any correlated (fleet) events in the last 24h.

5. TREND SNAPSHOT: After gathering the above metrics, call trend_snapshot to record today's data point.
   For each bot, provide: healthState, restartCount, errorCount, uptimePercent (estimate from uptime),
   stateTransitions (from health-state.json transitions in last 24h), and unreachableEpisodes.
   The uptimePercent can be estimated as: if the bot is currently healthy with uptime > 23h, use ~99-100;
   if it had downtime, estimate based on uptime duration vs 24h.

6. TREND ANALYSIS: After persisting the snapshot, call trend_analyze to check for patterns.
   If any proposals are returned, include a "Trends & Suggestions" section in the digest message.
   If no proposals are returned, omit the section entirely (no "nothing to report" noise).

Route this digest to the group channel (#the-bots-place, slack:C0AJ4J9H9L1) with info-severity formatting.
The daily digest is NEVER suppressed by quiet hours — always send it.

Format as a concise daily report:

\u{1F7E2} \u{1F4CA} **Daily Bot Health** — [date]

**Fleet Status**: [all-healthy | partial-degraded | fleet-down | maintenance]

**Active Maintenance**
\u2022 [bot]: [reason] (expires in [N] min) — or "No active maintenance modes"

**Correlated Events (24h)**
\u2022 [count] fleet-wide events — or "None"

**DB (OpenClaw)**
\u2022 Status: [state], uptime [duration]
\u2022 Errors (24h): [count] ([brief summary if any])
\u2022 Restarts (24h): [count]
\u2022 Open issues: [count]
\u2022 Policy actions (24h): [count and summary, or "none"]

**Nook (Letta)**
\u2022 Status: [state], uptime [duration]
\u2022 Errors (24h): [count] ([brief summary if any])
\u2022 Restarts (24h): [count]
\u2022 Open issues: [count]
\u2022 Policy actions (24h): [count and summary, or "none"]

**Suppressed Alerts (quiet hours)**
\u2022 [bot]: [count] [severity] alerts suppressed — or "None"

**Trends & Suggestions** (only include if trend_analyze returned proposals)
\u2022 [proposal summary] — [suggested action]

Keep it concise. Only elaborate on errors if there are notable patterns.`;
