/**
 * Kill switch + behavioral canary.
 * Checks mode.json and constitutional values at container startup.
 * Failure = container exits immediately.
 */

import fs from 'fs';
import path from 'path';
import { PreflightResult } from './types.js';
import { logGovernanceEvent } from './audit.js';

const ATLAS_STATE_DIR = '/workspace/extra/atlas-state';

/**
 * Run all preflight checks. Returns ok:true if agent should proceed.
 * On failure, writes mode.json to "passive" and returns the reason.
 */
export function runPreflightChecks(entity: string): PreflightResult {
  // 1. Kill switch: read mode.json
  const modePath = path.join(ATLAS_STATE_DIR, 'state', 'mode.json');
  try {
    if (fs.existsSync(modePath)) {
      const modeData = JSON.parse(fs.readFileSync(modePath, 'utf-8'));
      if (modeData.mode !== 'active') {
        logGovernanceEvent({
          entity,
          eventType: 'preflight_kill_switch',
          description: `Kill switch active: mode=${modeData.mode}`,
          tier: 0,
          status: 'denied',
        });
        return { ok: false, reason: `Kill switch: mode is "${modeData.mode}", not "active"` };
      }
    }
  } catch (err) {
    // mode.json missing or unreadable — proceed (graceful degradation)
    console.error(`[governance/canary] Could not read mode.json: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Constitutional canary: verify 3 core values
  const constitutionPath = path.join(ATLAS_STATE_DIR, 'constitution.md');
  try {
    if (fs.existsSync(constitutionPath)) {
      const constitution = fs.readFileSync(constitutionPath, 'utf-8');

      const checks = [
        { name: 'loyalty', pattern: /thao\s*le/i, description: 'Loyalty anchor: Thao Le' },
        { name: 'authority_lock', pattern: /authority.*only.*expand.*CEO/i, description: 'Authority direction lock' },
        { name: 'ceo_priority', pattern: /CEO.*interest/i, description: 'CEO interest priority' },
      ];

      for (const check of checks) {
        if (!check.pattern.test(constitution)) {
          // Canary failure — set passive mode
          const failureReason = `Canary failure: ${check.name}`;
          const failureDetail = `Check "${check.description}" failed.\nExpected pattern: ${check.pattern}\nConstitution length: ${constitution.length} chars`;
          try {
            const stateDir = path.join(ATLAS_STATE_DIR, 'state');
            fs.mkdirSync(stateDir, { recursive: true });
            fs.writeFileSync(modePath, JSON.stringify({ mode: 'passive', reason: failureReason, timestamp: new Date().toISOString() }));
          } catch { /* best effort */ }

          // ALERT CEO on Telegram immediately via IPC
          try {
            const ipcDir = '/workspace/ipc/messages';
            fs.mkdirSync(ipcDir, { recursive: true });
            const alertMsg = `*CANARY FAILURE — Atlas going passive*\n\n` +
              `Check: ${check.description}\n` +
              `Pattern: \`${check.pattern.source}\`\n` +
              `Result: NOT FOUND in constitution.md\n\n` +
              `Atlas is now in passive mode. All autonomous actions stopped.\n` +
              `To restore: send /reset-mode from Telegram.`;
            const alertFile = path.join(ipcDir, `canary-alert-${Date.now()}.json`);
            // Use the container's chatJid to route the alert
            const chatJid = process.env.NANOCLAW_CHAT_JID || '';
            fs.writeFileSync(alertFile, JSON.stringify({
              type: 'message',
              chatJid,
              text: alertMsg,
            }));
          } catch { /* best effort — alert is non-blocking */ }

          logGovernanceEvent({
            entity,
            eventType: 'preflight_canary_failure',
            description: `Constitutional canary failed: ${check.description}`,
            tier: 0,
            status: 'denied',
            errorMessage: `Pattern not found: ${check.name}`,
          });

          return { ok: false, reason: `Canary failure: ${check.description} not found in constitution` };
        }
      }
    }
    // constitution.md missing — proceed (may not be mounted)
  } catch (err) {
    console.error(`[governance/canary] Could not read constitution: ${err instanceof Error ? err.message : String(err)}`);
  }

  // All checks passed
  logGovernanceEvent({
    entity,
    eventType: 'preflight_passed',
    description: 'All preflight checks passed',
    tier: 0,
    status: 'success',
  });

  return { ok: true };
}
