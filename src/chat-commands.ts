import type { UxConfig } from './ux-config.js';

export interface ConfigListCommand {
  type: 'config';
  action: 'list';
}

export interface ConfigSetCommand {
  type: 'config';
  action: 'set';
  key: string;
  value: string;
}

export interface ConfigResetCommand {
  type: 'config';
  action: 'reset';
  key: string;
}

export interface SmokeTestCommand {
  type: 'smoketest';
}

export type ChatCommand =
  | ConfigListCommand
  | ConfigSetCommand
  | ConfigResetCommand
  | SmokeTestCommand;

export function parseCommand(text: string): ChatCommand | null {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  if (lower === 'smoketest') {
    return { type: 'smoketest' };
  }

  if (!lower.startsWith('config ') && lower !== 'config list') {
    return null;
  }

  const parts = trimmed.split(/\s+/);
  const action = parts[1]?.toLowerCase();

  if (action === 'list') {
    return { type: 'config', action: 'list' };
  }

  if (action === 'set' && parts.length >= 4) {
    const key = parts[2];
    const value = parts.slice(3).join(' ');
    return { type: 'config', action: 'set', key, value };
  }

  if (action === 'reset' && parts.length >= 3) {
    const key = parts[2];
    return { type: 'config', action: 'reset', key };
  }

  return null;
}

export function handleConfigCommand(
  cmd: ChatCommand,
  config: UxConfig,
): string {
  if (cmd.type !== 'config') return '';

  switch (cmd.action) {
    case 'list':
      return formatConfigList(config.list());

    case 'set': {
      try {
        config.set(cmd.key, cmd.value);
        return `✅ Set ${cmd.key} = ${cmd.value.length > 50 ? `${cmd.value.slice(0, 50)}...` : cmd.value}`;
      } catch (err) {
        return `❌ Invalid value for ${cmd.key}: ${err instanceof Error ? err.message : 'Unknown error'}`;
      }
    }

    case 'reset': {
      try {
        const items = config.list();
        const item = items.find((i) => i.key === cmd.key);
        config.reset(cmd.key);
        const defaultDisplay = item?.defaultValue ?? '(unknown)';
        return `✅ Reset ${cmd.key} to default (${defaultDisplay.length > 30 ? `${defaultDisplay.slice(0, 30)}...` : defaultDisplay})`;
      } catch (err) {
        return `❌ Failed to reset ${cmd.key}: ${err instanceof Error ? err.message : 'Unknown error'}`;
      }
    }
  }
}

export function formatConfigList(
  items: Array<{
    key: string;
    value: string;
    defaultValue: string;
    updatedAt: string;
  }>,
): string {
  const lines = items.map((item) => {
    let display: string;
    if (item.key === 'classifier.rules') {
      try {
        const arr = JSON.parse(item.value);
        display = `[${arr.length} rule${arr.length !== 1 ? 's' : ''}]`;
      } catch {
        display = '[invalid JSON]';
      }
    } else if (item.value.length > 50) {
      display = `[${item.value.length} chars]`;
    } else {
      display = item.value;
    }

    const isDefault = item.value === item.defaultValue;
    return `${item.key}: ${display}${isDefault ? ' (default)' : ' (modified)'}`;
  });

  return `⚙️ UX Configuration\n\n${lines.join('\n')}`;
}

// --- Smoke Test ---

export interface SmokeTestDeps {
  classifyAndFormat: (text: string) => {
    text: string;
    meta: { category: string; urgency?: string; actions: unknown[] };
  };
  gmailOpsRouter: {
    listRecentDrafts: (account: string) => Promise<unknown[]>;
    accounts: string[];
  };
  archiveTracker: {
    getUnarchived: () => unknown[];
  };
  draftWatcherRunning: boolean;
  uxConfig: {
    list: () => Array<{
      key: string;
      value: string;
      defaultValue: string;
      updatedAt: string;
    }>;
  };
  miniAppPort: number;
  triggerDebouncer: {
    getBufferSize: () => number;
  } | null;
}

export async function handleSmokeTest(deps: SmokeTestDeps): Promise<string> {
  const results: Array<{ name: string; ok: boolean; detail: string }> = [];

  // 1. Classifier
  try {
    const { meta } = deps.classifyAndFormat('incoming wire transfer received');
    results.push({
      name: 'Classifier',
      ok: true,
      detail: `${meta.category}/${meta.urgency ?? 'info'}`,
    });
  } catch (err) {
    results.push({
      name: 'Classifier',
      ok: false,
      detail: err instanceof Error ? err.message : 'unknown error',
    });
  }

  // 2. GmailOps
  const accountResults: string[] = [];
  for (const account of deps.gmailOpsRouter.accounts) {
    try {
      await Promise.race([
        deps.gmailOpsRouter.listRecentDrafts(account),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 10_000),
        ),
      ]);
      accountResults.push(account);
    } catch (err) {
      results.push({
        name: `GmailOps:${account}`,
        ok: false,
        detail: err instanceof Error ? err.message : 'unknown error',
      });
    }
  }
  if (accountResults.length > 0) {
    results.push({
      name: 'GmailOps',
      ok: true,
      detail: `${accountResults.length} account(s) responding (${accountResults.join(', ')})`,
    });
  }

  // 3. Archive tracker
  try {
    const unarchived = deps.archiveTracker.getUnarchived();
    results.push({
      name: 'Archive tracker',
      ok: true,
      detail: `${unarchived.length} unarchived email(s)`,
    });
  } catch (err) {
    results.push({
      name: 'Archive tracker',
      ok: false,
      detail: err instanceof Error ? err.message : 'unknown error',
    });
  }

  // 4. Draft watcher
  results.push({
    name: 'Draft watcher',
    ok: deps.draftWatcherRunning,
    detail: deps.draftWatcherRunning ? 'running' : 'not running',
  });

  // 5. UX config
  try {
    const items = deps.uxConfig.list();
    results.push({
      name: 'UX config',
      ok: items.length > 0,
      detail: `${items.length} keys loaded`,
    });
  } catch (err) {
    results.push({
      name: 'UX config',
      ok: false,
      detail: err instanceof Error ? err.message : 'unknown error',
    });
  }

  // 6. Mini App
  if (deps.miniAppPort > 0) {
    try {
      const resp = await fetch(
        `http://localhost:${deps.miniAppPort}/task/nonexistent`,
      );
      results.push({
        name: 'Mini App',
        ok: true,
        detail: `responding on port ${deps.miniAppPort} (status ${resp.status})`,
      });
    } catch (err) {
      results.push({
        name: 'Mini App',
        ok: false,
        detail: err instanceof Error ? err.message : 'not reachable',
      });
    }
  }

  // 7. Trigger debouncer
  if (deps.triggerDebouncer) {
    const bufferSize = deps.triggerDebouncer.getBufferSize();
    results.push({
      name: 'Trigger debouncer',
      ok: true,
      detail:
        bufferSize > 0
          ? `active, ${bufferSize} email(s) buffered`
          : 'idle, 0 email(s) buffered',
    });
  } else {
    results.push({
      name: 'Trigger debouncer',
      ok: false,
      detail: 'not initialized',
    });
  }

  // Format output
  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  const lines = results.map(
    (r) => `${r.ok ? '✅' : '❌'} ${r.name}: ${r.detail}`,
  );

  return `🔍 Smoke Test Results\n\n${lines.join('\n')}\n\n${passed}/${total} checks passed`;
}
