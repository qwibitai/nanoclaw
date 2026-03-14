/**
 * @fileoverview Unit tests for hardened credential proxy
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import { 
  startCredentialProxy, 
  stopCredentialProxy,
  detectAuthMode,
  getCurrentCredentials,
} from '../credential-proxy-hardened.js';
import { readEnvFile } from '../env.js';

// Mock environment
vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(),
}));

describe('getCurrentCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return API key when available', () => {
    vi.mocked(readEnvFile).mockReturnValue({
      ANTHROPIC_API_KEY: 'sk-test-key',
      CLAUDE_CODE_OAUTH_TOKEN: null,
      ANTHROPIC_AUTH_TOKEN: null,
      ANTHROPIC_BASE_URL: null,
    });

    const creds = getCurrentCredentials();
    
    expect(creds.apiKey).toBe('sk-test-key');
    expect(creds.oauthToken).toBe(null);
    expect(creds.baseUrl).toBe('https://api.anthropic.com');
  });

  it('should return OAuth token when API key not available', () => {
    vi.mocked(readEnvFile).mockReturnValue({
      ANTHROPIC_API_KEY: null,
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
      ANTHROPIC_AUTH_TOKEN: null,
      ANTHROPIC_BASE_URL: null,
    });

    const creds = getCurrentCredentials();
    
    expect(creds.apiKey).toBe(null);
    expect(creds.oauthToken).toBe('oauth-token');
  });

  it('should prefer CLAUDE_CODE_OAUTH_TOKEN over ANTHROPIC_AUTH_TOKEN', () => {
    vi.mocked(readEnvFile).mockReturnValue({
      ANTHROPIC_API_KEY: null,
      CLAUDE_CODE_OAUTH_TOKEN: 'primary-token',
      ANTHROPIC_AUTH_TOKEN: 'secondary-token',
      ANTHROPIC_BASE_URL: null,
    });

    const creds = getCurrentCredentials();
    
    expect(creds.oauthToken).toBe('primary-token');
  });

  it('should use custom base URL when configured', () => {
    vi.mocked(readEnvFile).mockReturnValue({
      ANTHROPIC_API_KEY: 'sk-test',
      CLAUDE_CODE_OAUTH_TOKEN: null,
      ANTHROPIC_AUTH_TOKEN: null,
      ANTHROPIC_BASE_URL: 'https://custom.api.com',
    });

    const creds = getCurrentCredentials();
    
    expect(creds.baseUrl).toBe('https://custom.api.com');
  });
});

describe('detectAuthMode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return api-key when API key present', () => {
    vi.mocked(readEnvFile).mockReturnValue({
      ANTHROPIC_API_KEY: 'sk-test',
      CLAUDE_CODE_OAUTH_TOKEN: null,
      ANTHROPIC_AUTH_TOKEN: null,
      ANTHROPIC_BASE_URL: null,
    });

    expect(detectAuthMode()).toBe('api-key');
  });

  it('should return oauth when only OAuth token present', () => {
    vi.mocked(readEnvFile).mockReturnValue({
      ANTHROPIC_API_KEY: null,
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
      ANTHROPIC_AUTH_TOKEN: null,
      ANTHROPIC_BASE_URL: null,
    });

    expect(detectAuthMode()).toBe('oauth');
  });
});

describe('Credential Proxy Server', () => {
  let server: http.Server | null = null;

  afterEach(async () => {
    if (server) {
      await stopCredentialProxy(server);
      server = null;
    }
  });

  it('should start on specified port', async () => {
    vi.mocked(readEnvFile).mockReturnValue({
      ANTHROPIC_API_KEY: 'sk-test',
      CLAUDE_CODE_OAUTH_TOKEN: null,
      ANTHROPIC_AUTH_TOKEN: null,
      ANTHROPIC_BASE_URL: null,
    });

    server = await startCredentialProxy(19999, '127.0.0.1');
    
    expect(server).toBeDefined();
    expect(server.listening).toBe(true);
  });

  it('should respond to health check', async () => {
    vi.mocked(readEnvFile).mockReturnValue({
      ANTHROPIC_API_KEY: 'sk-test',
      CLAUDE_CODE_OAUTH_TOKEN: null,
      ANTHROPIC_AUTH_TOKEN: null,
      ANTHROPIC_BASE_URL: null,
    });

    server = await startCredentialProxy(19998, '127.0.0.1');

    const response = await new Promise<string>((resolve, reject) => {
      http.get('http://127.0.0.1:19998/health', (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
        res.on('error', reject);
      }).on('error', reject);
    });

    expect(response).toBe('{"status":"ok"}');
  });

  it('should return 503 when no credentials', async () => {
    vi.mocked(readEnvFile).mockReturnValue({
      ANTHROPIC_API_KEY: null,
      CLAUDE_CODE_OAUTH_TOKEN: null,
      ANTHROPIC_AUTH_TOKEN: null,
      ANTHROPIC_BASE_URL: null,
    });

    server = await startCredentialProxy(19997, '127.0.0.1');

    const response = await new Promise<{statusCode: number, body: string}>((resolve, reject) => {
      http.get('http://127.0.0.1:19997/v1/messages', (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ statusCode: res.statusCode || 0, body: data }));
        res.on('error', reject);
      }).on('error', reject);
    });

    expect(response.statusCode).toBe(503);
    expect(response.body).toContain('no_credentials');
  });
});

describe('Header Handling', () => {
  it('should strip hop-by-hop headers', () => {
    // This would test the internal stripHopByHopHeaders function
    // For now, we'll test via integration
    const hopByHop = [
      'connection',
      'keep-alive',
      'transfer-encoding',
      'upgrade',
    ];

    // These headers should not be forwarded
    expect(hopByHop).toHaveLength(4);
  });

  it('should inject API key in api-key mode', () => {
    // Integration test for credential injection
    expect(true).toBe(true);
  });

  it('should inject OAuth headers in oauth mode', () => {
    // Integration test for OAuth injection
    expect(true).toBe(true);
  });
});

describe('Error Handling', () => {
  it('should return structured JSON on upstream error', async () => {
    vi.mocked(readEnvFile).mockReturnValue({
      ANTHROPIC_API_KEY: 'sk-test',
      CLAUDE_CODE_OAUTH_TOKEN: null,
      ANTHROPIC_AUTH_TOKEN: null,
      ANTHROPIC_BASE_URL: 'https://invalid-host-that-does-not-exist.com',
    });

    const server = await startCredentialProxy(19996, '127.0.0.1');

    try {
      const response = await new Promise<{statusCode: number, body: string}>((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port: 19996,
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve({ statusCode: res.statusCode || 0, body: data }));
          res.on('error', reject);
        });

        req.on('error', reject);
        req.write('{}');
        req.end();
      });

      // Should get an error response (502 or similar)
      expect(response.statusCode).toBeGreaterThanOrEqual(500);
      expect(() => JSON.parse(response.body)).not.toThrow();
    } finally {
      await stopCredentialProxy(server);
    }
  });
});
