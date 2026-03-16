import type { Server } from 'http';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

export function startCredentialProxy(_port: number, _host = '127.0.0.1'): Promise<Server> {
  logger.warn('Credential proxy is deprecated and has been removed');
  const http = require('http');
  const server = http.createServer(
    (_req: import('http').IncomingMessage, res: import('http').ServerResponse) => {
      res.writeHead(410);
      res.end('Gone');
    },
  );
  return Promise.resolve(server);
}

export function detectAuthMode(): AuthMode {
  return 'api-key';
}
