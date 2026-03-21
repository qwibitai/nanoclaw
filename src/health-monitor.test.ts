import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HealthMonitor, type HealthAlert } from './health-monitor.js';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('HealthMonitor', () => {
  let monitor: HealthMonitor;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let alertFn: ReturnType<typeof vi.fn> & ((alert: HealthAlert) => void);

  beforeEach(() => {
    alertFn = vi.fn() as ReturnType<typeof vi.fn> &
      ((alert: HealthAlert) => void);
    monitor = new HealthMonitor({
      maxSpawnsPerHour: 30,
      maxErrorsPerHour: 20,
      onAlert: alertFn,
    });
  });

  it('tracks container spawns', () => {
    monitor.recordSpawn('main');
    expect(monitor.getSpawnCount('main', 3600_000)).toBe(1);
  });

  it('alerts when spawn rate exceeds threshold', () => {
    for (let i = 0; i < 31; i++) {
      monitor.recordSpawn('main');
    }
    const alerts = monitor.checkThresholds();
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0]).toMatchObject({
      type: 'excessive_spawns',
      group: 'main',
    });
    expect(alertFn).toHaveBeenCalled();
  });

  it('tracks errors by group', () => {
    monitor.recordError('main', 'Container timeout');
    expect(monitor.getErrorCount('main', 3600_000)).toBe(1);
  });

  it('alerts when error rate exceeds threshold', () => {
    for (let i = 0; i < 21; i++) {
      monitor.recordError('main', 'fail');
    }
    const alerts = monitor.checkThresholds();
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0]).toMatchObject({
      type: 'excessive_errors',
      group: 'main',
    });
  });

  it('pauses and resumes groups', () => {
    monitor.pauseGroup('main', 'test');
    expect(monitor.isGroupPaused('main')).toBe(true);
    monitor.resumeGroup('main');
    expect(monitor.isGroupPaused('main')).toBe(false);
  });

  it('only counts events within the time window', () => {
    // Inject an old event directly
    monitor['spawnLog'].push({
      group: 'main',
      timestamp: Date.now() - 7200_000,
    });
    monitor.recordSpawn('main');
    expect(monitor.getSpawnCount('main', 3600_000)).toBe(1);
  });

  it('returns status summary', () => {
    monitor.recordSpawn('main');
    monitor.recordError('main', 'test');
    const status = monitor.getStatus();
    expect(status['main']).toMatchObject({
      spawns_1h: 1,
      errors_1h: 1,
      paused: false,
    });
  });
});

describe('HealthMonitor Ollama tracking', () => {
  let monitor: HealthMonitor;

  beforeEach(() => {
    monitor = new HealthMonitor({
      maxSpawnsPerHour: 30,
      maxErrorsPerHour: 20,
      onAlert: vi.fn(),
    });
  });

  it('records Ollama latency', () => {
    monitor.recordOllamaLatency(500);
    monitor.recordOllamaLatency(1000);
    expect(monitor.getOllamaP95Latency(3600_000)).toBeGreaterThan(0);
  });

  it('reports not degraded when latency is low', () => {
    for (let i = 0; i < 10; i++) monitor.recordOllamaLatency(200);
    expect(monitor.isOllamaDegraded()).toBe(false);
  });

  it('reports degraded when p95 exceeds threshold', () => {
    for (let i = 0; i < 19; i++) monitor.recordOllamaLatency(100);
    monitor.recordOllamaLatency(15000);
    expect(monitor.isOllamaDegraded()).toBe(true);
  });

  it('only considers latency within time window', () => {
    monitor['ollamaLatencyLog'].push({
      latencyMs: 15000,
      timestamp: Date.now() - 7200_000,
    });
    for (let i = 0; i < 10; i++) monitor.recordOllamaLatency(100);
    expect(monitor.isOllamaDegraded()).toBe(false);
  });
});
