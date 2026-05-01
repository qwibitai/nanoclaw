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

import { log } from '../log.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

log.info('Loading Gemini provider host config');

registerProviderContainerConfig('gemini', (ctx) => {
  const geminiDir = path.join(ctx.sessionDir, 'gemini');
  fs.mkdirSync(geminiDir, { recursive: true });

  // Determine the auth method and copy essential files.
  const hostHome = ctx.hostEnv.HOME;
  let authMethod = 'api-key';

  if (hostHome) {
    const hostGemini = path.join(hostHome, '.gemini');
    if (fs.existsSync(hostGemini)) {
      // oauth_creds.json & google_accounts.json: primary authentication
      // installation_id: hardware-linked identity (often required by the API)
      // projects.json: GCA/Vertex project selection state
      const AUTH_FILES = ['oauth_creds.json', 'google_accounts.json', 'installation_id', 'projects.json'];
      let hasOauth = false;
      for (const file of AUTH_FILES) {
        const src = path.join(hostGemini, file);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, path.join(geminiDir, file));
          if (file === 'oauth_creds.json') hasOauth = true;
        }
      }

      // Favor OAuth if credentials exist and no API key is explicitly provided
      if (hasOauth && !ctx.hostEnv.GEMINI_API_KEY && !ctx.hostEnv.GOOGLE_API_KEY) {
        authMethod = 'oauth-personal';
      }
    }
  }

  // Always generate a clean settings.json for the container. This ensures
  // we use the correct auth method without leaking host-side MCP servers,
  // editor preferences, or other personal settings.
  const settings = {
    security: {
      auth: {
        selectedType: authMethod,
      },
    },
  };
  fs.writeFileSync(path.join(geminiDir, 'settings.json'), JSON.stringify(settings, null, 2));
  log.info('Gemini session auth initialized', { sessionDir: ctx.sessionDir, authMethod });

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

  const mounts: { hostPath: string; containerPath: string; readonly: boolean }[] = [
    { hostPath: geminiDir, containerPath: '/home/node/.gemini', readonly: false },
  ];

  // Mount container skills into Gemini's user-level skills directory so the
  // agent picks them up the same way Claude agents do via .claude-fragments.
  const skillsHostPath = path.join(process.cwd(), 'container', 'skills');
  if (fs.existsSync(skillsHostPath)) {
    mounts.push({ hostPath: skillsHostPath, containerPath: '/home/node/.gemini/skills', readonly: true });
  }

  return { mounts, env };
});

