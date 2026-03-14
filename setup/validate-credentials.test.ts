import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { run } from './validate-credentials.js';
import * as envModule from '../src/env.js';
import * as statusModule from './status.js';

// Mock the modules
vi.mock('../src/env.js');
vi.mock('./status.js');
vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('validate-credentials', () => {
  const originalFetch = global.fetch;
  let fetchMock: any;

  beforeEach(() => {
    vi.resetAllMocks();
    fetchMock = vi.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('skips validation when neither token is present', async () => {
    vi.mocked(envModule.readEnvFile).mockReturnValue({});
    
    await run([]);
    
    expect(statusModule.emitStatus).toHaveBeenCalledWith('VALIDATE_CREDENTIALS', {
      STATUS: 'success',
      SKIPPED: true,
      LOG: 'logs/setup.log',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('emits failed when API returns 401', async () => {
    vi.mocked(envModule.readEnvFile).mockReturnValue({
      ANTHROPIC_API_KEY: 'invalid-key',
    });
    
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: vi.fn().mockResolvedValue('Unauthorized'),
    });
    
    await run([]);
    
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers['x-api-key']).toBe('invalid-key');
    expect(statusModule.emitStatus).toHaveBeenCalledWith('VALIDATE_CREDENTIALS', {
      STATUS: 'failed',
      ERROR: 'Invalid bearer token',
    });
  });

  it('emits success when API returns 200 via ANTHROPIC_API_KEY', async () => {
    vi.mocked(envModule.readEnvFile).mockReturnValue({
      ANTHROPIC_API_KEY: 'valid-key',
    });
    
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue('OK'),
    });
    
    await run([]);
    
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers['x-api-key']).toBe('valid-key');
    expect(statusModule.emitStatus).toHaveBeenCalledWith('VALIDATE_CREDENTIALS', {
      STATUS: 'success',
      LOG: 'logs/setup.log',
    });
  });

  it('emits success when API returns 200 via CLAUDE_CODE_OAUTH_TOKEN', async () => {
    vi.mocked(envModule.readEnvFile).mockReturnValue({
      CLAUDE_CODE_OAUTH_TOKEN: 'valid-oauth-token',
    });
    
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue('OK'),
    });
    
    await run([]);
    
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers['authorization']).toBe('Bearer valid-oauth-token');
    expect(statusModule.emitStatus).toHaveBeenCalledWith('VALIDATE_CREDENTIALS', {
      STATUS: 'success',
      LOG: 'logs/setup.log',
    });
  });

  it('emits success with warning when network request fails', async () => {
    vi.mocked(envModule.readEnvFile).mockReturnValue({
      ANTHROPIC_API_KEY: 'valid-key',
    });
    
    fetchMock.mockRejectedValue(new Error('Network offline'));
    
    await run([]);
    
    expect(statusModule.emitStatus).toHaveBeenCalledWith('VALIDATE_CREDENTIALS', {
      STATUS: 'success',
      WARNING: 'Network error during validation',
      LOG: 'logs/setup.log',
    });
  });

  it('emits success for non-401 error like 403', async () => {
    vi.mocked(envModule.readEnvFile).mockReturnValue({
      ANTHROPIC_API_KEY: 'valid-key',
    });
    
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      text: vi.fn().mockResolvedValue('Forbidden (e.g. no billing)'),
    });
    
    await run([]);
    
    expect(statusModule.emitStatus).toHaveBeenCalledWith('VALIDATE_CREDENTIALS', {
      STATUS: 'success',
      LOG: 'logs/setup.log',
    });
  });
});
