import fs from 'fs';
import path from 'path';

export function loadJson<T>(filePath: string, defaultValue: T): T {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch {
    // Return default on error
  }
  return defaultValue;
}

export function saveJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/**
 * Acquire PID file lock to prevent multiple instances
 * @returns true if lock acquired, false if another instance is running
 */
export function acquirePidLock(pidFile: string): boolean {
  try {
    if (fs.existsSync(pidFile)) {
      const existingPid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
      try {
        process.kill(existingPid, 0);
        console.error(`Already running (PID: ${existingPid}). Exiting.`);
        return false;
      } catch {
        fs.unlinkSync(pidFile);
      }
    }

    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, String(process.pid));

    const cleanup = () => {
      try {
        if (fs.existsSync(pidFile)) {
          const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
          if (pid === process.pid) fs.unlinkSync(pidFile);
        }
      } catch {}
    };

    process.on('exit', cleanup);
    process.on('SIGINT', () => { cleanup(); process.exit(0); });
    process.on('SIGTERM', () => { cleanup(); process.exit(0); });

    return true;
  } catch (err) {
    console.error('Failed to acquire lock:', err);
    return false;
  }
}
