/**
 * Cross-platform detection utilities for NanoClaw setup.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

export type Platform = 'macos' | 'linux' | 'unknown';
export type ServiceManager = 'launchd' | 'systemd' | 'none';

export function getPlatform(): Platform {
  const platform = os.platform();
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  return 'unknown';
}

export function isWSL(): boolean {
  if (os.platform() !== 'linux') return false;
  try {
    const release = fs.readFileSync('/proc/version', 'utf-8').toLowerCase();
    return release.includes('microsoft') || release.includes('wsl');
  } catch {
    return false;
  }
}

export function isRoot(): boolean {
  return process.getuid?.() === 0;
}

export function isHeadless(): boolean {
  // No display server available
  if (getPlatform() === 'linux') {
    return !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
  }
  // macOS is never headless in practice (even SSH sessions can open URLs)
  return false;
}

export function hasSystemd(): boolean {
  if (getPlatform() !== 'linux') return false;
  try {
    // Check if systemd is PID 1
    const init = fs.readFileSync('/proc/1/comm', 'utf-8').trim();
    return init === 'systemd';
  } catch {
    return false;
  }
}

/**
 * Open a URL in the default browser, cross-platform.
 * Returns true if the command was attempted, false if no method available.
 */
export function openBrowser(url: string): boolean {
  try {
    const platform = getPlatform();
    if (platform === 'macos') {
      execSync(`open ${JSON.stringify(url)}`, { stdio: 'ignore' });
      return true;
    }
    if (platform === 'linux') {
      // In WSL, prefer Windows-native openers before xdg-open (which needs a display)
      if (isWSL()) {
        if (commandExists('wslview')) {
          try {
            execSync(`wslview ${JSON.stringify(url)}`, { stdio: 'ignore' });
            return true;
          } catch { /* try next */ }
        }
        try {
          // Convert WSL path to Windows path if it's a file path
          let winUrl = url;
          if (url.startsWith('/')) {
            try { winUrl = execSync(`wslpath -w ${JSON.stringify(url)}`, { encoding: 'utf-8' }).trim(); } catch { /* keep original */ }
          }
          execSync(`cmd.exe /c start "" ${JSON.stringify(winUrl)}`, { stdio: 'ignore' });
          return true;
        } catch { /* try next */ }
      }
      // Non-WSL Linux: xdg-open
      if (commandExists('xdg-open')) {
        try {
          execSync(`xdg-open ${JSON.stringify(url)}`, { stdio: 'ignore' });
          return true;
        } catch { /* failed */ }
      }
    }
  } catch {
    // Command failed
  }
  return false;
}

export function getServiceManager(): ServiceManager {
  const platform = getPlatform();
  if (platform === 'macos') return 'launchd';
  if (platform === 'linux') {
    if (hasSystemd()) return 'systemd';
    return 'none';
  }
  return 'none';
}

export function getNodePath(): string {
  try {
    return execSync('command -v node', { encoding: 'utf-8' }).trim();
  } catch {
    return process.execPath;
  }
}

export function commandExists(name: string): boolean {
  try {
    execSync(`command -v ${name}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function getNodeVersion(): string | null {
  try {
    const version = execSync('node --version', { encoding: 'utf-8' }).trim();
    return version.replace(/^v/, '');
  } catch {
    return null;
  }
}

export function getNodeMajorVersion(): number | null {
  const version = getNodeVersion();
  if (!version) return null;
  const major = parseInt(version.split('.')[0], 10);
  return isNaN(major) ? null : major;
}
