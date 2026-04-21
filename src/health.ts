// src/health.ts
import fs from 'node:fs';
import net from 'node:net';

export interface HealthStatus {
  status: 'ok';
  version: string;
  uptimeMs: number;
  channelsConnected: string[];
  dbOk: boolean;
  registeredGroupsCount: number;
}

export interface HealthGetters {
  channelsConnected: string[];
  dbOk: boolean;
  registeredGroupsCount: number;
}

export interface HealthServer {
  stop(): Promise<void>;
}

export function startHealthServer(
  socketPath: string,
  getStatus: () => HealthGetters,
): HealthServer {
  const startTime = Date.now();

  // Read package.json version once at startup; ../package.json resolves from
  // dist/health.js (compiled) and from src/health.ts (tsx dev) equally.
  let version = 'unknown';
  try {
    const pkgUrl = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(fs.readFileSync(pkgUrl, 'utf8')) as { version: string };
    version = pkg.version;
  } catch { /* non-fatal — version stays 'unknown' */ }

  // Remove stale socket file so bind succeeds after an unclean shutdown
  try { fs.unlinkSync(socketPath); } catch { /* doesn't exist — fine */ }

  const server = net.createServer((socket) => {
    const payload: HealthStatus = {
      status: 'ok',
      version,
      uptimeMs: Date.now() - startTime,
      ...getStatus(),
    };
    socket.end(JSON.stringify(payload) + '\n');
  });

  server.listen(socketPath);

  return {
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          try { fs.unlinkSync(socketPath); } catch { /* already gone */ }
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}
