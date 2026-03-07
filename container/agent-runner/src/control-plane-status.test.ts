import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { buildLaneStatusToolResponse } from './control-plane-status.js';

describe('control-plane-status', () => {
  it('rejects non-main callers', () => {
    const result = buildLaneStatusToolResponse('andy-developer', {
      isMain: false,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      'Only the main lane can read control-plane lane status',
    );
  });

  it('rejects unsupported lane ids', () => {
    const result = buildLaneStatusToolResponse('jarvis-worker-1', {
      isMain: true,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unsupported lane status target');
  });

  it('returns structured lane status from the snapshot file', () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-control-plane-status-'),
    );
    const snapshotPath = path.join(tempDir, 'control_plane_status.json');
    fs.writeFileSync(
      snapshotPath,
      JSON.stringify(
        {
          generated_at: '2026-03-07T10:00:00.000Z',
          lanes: {
            'andy-developer': {
              lane_id: 'andy-developer',
              availability: 'busy',
              active_request_id: 'req-status-1',
              active_run_id: 'run-status-1',
              summary: 'Andy Developer is busy. Current tracked requests: ...',
              updated_at: '2026-03-07T10:00:00.000Z',
              active_requests: [
                {
                  request_id: 'req-status-1',
                  state: 'coordinator_active',
                  worker_run_id: 'run-status-1',
                  worker_group_folder: 'jarvis-worker-1',
                  updated_at: '2026-03-07T10:00:00.000Z',
                },
              ],
            },
          },
        },
        null,
        2,
      ),
    );

    const result = buildLaneStatusToolResponse('andy-developer', {
      isMain: true,
      snapshotPath,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Andy Developer is busy');
    expect(result.structuredContent?.active_request_id).toBe('req-status-1');
    expect(result.structuredContent?.active_requests).toHaveLength(1);
  });

  it('defaults to andy-developer when lane_id is omitted', () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-control-plane-status-default-'),
    );
    const snapshotPath = path.join(tempDir, 'control_plane_status.json');
    fs.writeFileSync(
      snapshotPath,
      JSON.stringify(
        {
          generated_at: '2026-03-07T10:00:00.000Z',
          lanes: {
            'andy-developer': {
              lane_id: 'andy-developer',
              availability: 'idle',
              summary: 'Andy Developer is idle. No worker run is active right now.',
              updated_at: '2026-03-07T10:00:00.000Z',
              active_requests: [],
            },
          },
        },
        null,
        2,
      ),
    );

    const result = buildLaneStatusToolResponse(undefined, {
      isMain: true,
      snapshotPath,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Andy Developer is idle');
  });

  it('returns an availability error when the snapshot file is missing', () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-control-plane-status-missing-'),
    );
    const snapshotPath = path.join(tempDir, 'missing.json');

    const result = buildLaneStatusToolResponse('andy-developer', {
      isMain: true,
      snapshotPath,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      'Control-plane status is temporarily unavailable',
    );
  });
});
