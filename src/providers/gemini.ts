/**
 * Host-side container config for the `gemini` provider.
 *
 * Gemini CLI reads auth and configuration from ~/.gemini. We give each session
 * its own private copy of that directory to ensure isolation and prevent
 * racing between concurrent sessions.
 *
 * Env passthrough covers:
 *   GEMINI_API_KEY  — API key from Google AI Studio
 *   GOOGLE_API_KEY  — Alternate key name for Vertex AI
 *   GEMINI_MODEL    — Model override (e.g. gemini-1.5-pro)
 */
import fs from 'fs';
import path from 'path';

import { registerProviderContainerConfig } from './provider-container-registry.js';

registerProviderContainerConfig('gemini', (ctx) => {
  const geminiDir = path.join(ctx.sessionDir, 'gemini');
  fs.mkdirSync(geminiDir, { recursive: true });

  // Copy essential auth/config files from ~/.gemini into the per-session dir.
  // We avoid copying the whole directory to prevent leaking host session
  // history, project metadata, or unrelated state into the container.
  const hostHome = ctx.hostEnv.HOME;
  if (hostHome) {
    const hostGemini = path.join(hostHome, '.gemini');
    if (fs.existsSync(hostGemini)) {
      const AUTH_FILES = ['oauth_creds.json', 'google_accounts.json', 'settings.json', 'installation_id', 'state.json'];
      for (const file of AUTH_FILES) {
        const src = path.join(hostGemini, file);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, path.join(geminiDir, file));
        }
      }
    }
  }

  const env: Record<string, string> = {};
  const VARS = [
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GEMINI_MODEL',
    'GOOGLE_CLOUD_PROJECT',
    'GOOGLE_CLOUD_LOCATION',
    'GOOGLE_APPLICATION_CREDENTIALS',
  ] as const;

  for (const key of VARS) {
    const value = ctx.hostEnv[key];
    if (value) env[key] = value;
  }

  return {
    mounts: [{ hostPath: geminiDir, containerPath: '/home/node/.gemini', readonly: false }],
    env,
  };
});

function copyRecursiveSync(src: string, dest: string) {
  const exists = fs.existsSync(src);
  const stats = exists && fs.statSync(src);
  const isDirectory = exists && stats && stats.isDirectory();
  if (isDirectory) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest);
    fs.readdirSync(src).forEach((childItemName) => {
      copyRecursiveSync(path.join(src, childItemName), path.join(dest, childItemName));
    });
  } else {
    fs.copyFileSync(src, dest);
  }
}
