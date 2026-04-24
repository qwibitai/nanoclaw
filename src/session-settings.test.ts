import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('updateAllGroupSettings', () => {
  let testDir: string;
  let originalCwd: string;

  beforeEach(() => {
    // Create a temporary test directory
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-test-'));
    originalCwd = process.cwd();

    // Create directory structure
    const dataDir = path.join(testDir, 'data', 'sessions');
    const hooksDir = path.join(testDir, 'container', 'hooks');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(hooksDir, { recursive: true });

    // Change to test directory
    process.chdir(testDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(testDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('should add PostToolUse hooks to settings files missing them', async () => {
    // Setup: create a group settings file without PostToolUse hooks
    const groupDir = path.join(testDir, 'data', 'sessions', 'test-group', '.claude');
    fs.mkdirSync(groupDir, { recursive: true });

    const settingsFile = path.join(groupDir, 'settings.json');
    const existingSettings = {
      env: { SOME_VAR: '1' },
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: '/path/to/service-guard.sh' }],
          },
        ],
      },
    };
    fs.writeFileSync(settingsFile, JSON.stringify(existingSettings, null, 2));

    // Create tool-observer.sh hook file
    const toolObserverHook = path.join(testDir, 'container', 'hooks', 'tool-observer.sh');
    fs.writeFileSync(toolObserverHook, '#!/bin/bash\necho "observer"');

    // Import and run the update function
    const { updateAllGroupSettings } = await import('./session-settings.js');
    updateAllGroupSettings();

    // Verify hooks were added
    const updated = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    expect(updated.hooks.PostToolUse).toBeDefined();
    expect(updated.hooks.PostToolUseFailure).toBeDefined();
    expect(updated.hooks.PostToolUse[0].matcher).toBe('');
    expect(updated.hooks.PostToolUse[0].hooks[0].command).toBe(toolObserverHook);
  });

  it('should not modify settings files that already have PostToolUse hooks', async () => {
    // Setup: create a group settings file WITH PostToolUse hooks
    const groupDir = path.join(testDir, 'data', 'sessions', 'test-group', '.claude');
    fs.mkdirSync(groupDir, { recursive: true });

    const settingsFile = path.join(groupDir, 'settings.json');
    const existingSettings = {
      env: { SOME_VAR: '1' },
      hooks: {
        PostToolUse: [{ matcher: '', hooks: [{ type: 'command', command: '/existing/hook' }] }],
        PostToolUseFailure: [{ matcher: '', hooks: [{ type: 'command', command: '/existing/hook' }] }],
      },
    };
    fs.writeFileSync(settingsFile, JSON.stringify(existingSettings, null, 2));

    // Create tool-observer.sh hook file
    const toolObserverHook = path.join(testDir, 'container', 'hooks', 'tool-observer.sh');
    fs.writeFileSync(toolObserverHook, '#!/bin/bash\necho "observer"');

    const mtimeBefore = fs.statSync(settingsFile).mtimeMs;

    // Import and run the update function
    const { updateAllGroupSettings } = await import('./session-settings.js');
    updateAllGroupSettings();

    // Verify file was NOT modified (with a small tolerance for filesystem timing)
    const mtimeAfter = fs.statSync(settingsFile).mtimeMs;
    expect(Math.abs(mtimeAfter - mtimeBefore)).toBeLessThan(1000);

    const updated = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    expect(updated.hooks.PostToolUse[0].hooks[0].command).toBe('/existing/hook');
  });

  it('should skip update if tool-observer.sh does not exist', async () => {
    // Setup: create a group settings file without PostToolUse hooks
    const groupDir = path.join(testDir, 'data', 'sessions', 'test-group', '.claude');
    fs.mkdirSync(groupDir, { recursive: true });

    const settingsFile = path.join(groupDir, 'settings.json');
    const existingSettings = {
      env: { SOME_VAR: '1' },
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: '/path/to/service-guard.sh' }],
          },
        ],
      },
    };
    fs.writeFileSync(settingsFile, JSON.stringify(existingSettings, null, 2));

    // DO NOT create tool-observer.sh

    const mtimeBefore = fs.statSync(settingsFile).mtimeMs;

    // Import and run the update function
    const { updateAllGroupSettings } = await import('./session-settings.js');
    updateAllGroupSettings();

    // Verify file was NOT modified
    const mtimeAfter = fs.statSync(settingsFile).mtimeMs;
    expect(Math.abs(mtimeAfter - mtimeBefore)).toBeLessThan(1000);

    const updated = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    expect(updated.hooks.PostToolUse).toBeUndefined();
  });

  it('should handle multiple groups', async () => {
    // Setup: create multiple group settings files
    const group1Dir = path.join(testDir, 'data', 'sessions', 'group1', '.claude');
    const group2Dir = path.join(testDir, 'data', 'sessions', 'group2', '.claude');
    fs.mkdirSync(group1Dir, { recursive: true });
    fs.mkdirSync(group2Dir, { recursive: true });

    const settings1File = path.join(group1Dir, 'settings.json');
    const settings2File = path.join(group2Dir, 'settings.json');

    fs.writeFileSync(
      settings1File,
      JSON.stringify({ env: {}, hooks: {} }, null, 2),
    );
    fs.writeFileSync(
      settings2File,
      JSON.stringify({ env: {}, hooks: {} }, null, 2),
    );

    // Create tool-observer.sh hook file
    const toolObserverHook = path.join(testDir, 'container', 'hooks', 'tool-observer.sh');
    fs.writeFileSync(toolObserverHook, '#!/bin/bash\necho "observer"');

    // Import and run the update function
    const { updateAllGroupSettings } = await import('./session-settings.js');
    updateAllGroupSettings();

    // Verify both were updated
    const updated1 = JSON.parse(fs.readFileSync(settings1File, 'utf8'));
    const updated2 = JSON.parse(fs.readFileSync(settings2File, 'utf8'));

    expect(updated1.hooks.PostToolUse).toBeDefined();
    expect(updated2.hooks.PostToolUse).toBeDefined();
  });
});
