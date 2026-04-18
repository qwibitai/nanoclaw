import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  parseStepFromNarration,
  buildProcedure,
  saveProcedureViaIpc,
} from './teach-mode.js';

// ────────────────────────────────────────────────────────────────
// parseStepFromNarration — exhaustive action recognition
// ────────────────────────────────────────────────────────────────
describe('parseStepFromNarration', () => {
  describe('navigate action', () => {
    it.each([
      ['Go to alto.com', 'alto.com'],
      ['go to https://github.com/settings', 'https://github.com/settings'],
      ['Navigate to the dashboard', 'the dashboard'],
      ['navigate to settings page', 'settings page'],
      ['Open https://mail.google.com', 'https://mail.google.com'],
      ['open the calendar app', 'the calendar app'],
    ])('parses "%s" → navigate target "%s"', (narration, expectedTarget) => {
      const step = parseStepFromNarration(narration);
      expect(step).not.toBeNull();
      expect(step!.action).toBe('navigate');
      expect(step!.target).toBe(expectedTarget);
      expect(step!.description).toBe(narration);
    });
  });

  describe('click action', () => {
    it.each([
      ['Click Medications tab', 'Medications tab'],
      ['click the submit button', 'the submit button'],
      ['Press Enter', 'Enter'],
      ['press the save icon', 'the save icon'],
      ['Tap the notification bell', 'the notification bell'],
      ['tap Settings', 'Settings'],
    ])('parses "%s" → click target "%s"', (narration, expectedTarget) => {
      const step = parseStepFromNarration(narration);
      expect(step).not.toBeNull();
      expect(step!.action).toBe('click');
      expect(step!.target).toBe(expectedTarget);
    });

    it('strips "on" preposition from click targets', () => {
      const step = parseStepFromNarration('Click on the menu');
      expect(step).not.toBeNull();
      expect(step!.action).toBe('click');
      expect(step!.target).toBe('the menu');
    });
  });

  describe('find action', () => {
    it.each([
      ['Find Lisinopril', 'Lisinopril'],
      ['find the error message', 'the error message'],
      ['Look for the login button', 'the login button'],
      ['look for recent orders', 'recent orders'],
      ['Locate the settings panel', 'the settings panel'],
      ['locate my account', 'my account'],
    ])('parses "%s" → find target "%s"', (narration, expectedTarget) => {
      const step = parseStepFromNarration(narration);
      expect(step).not.toBeNull();
      expect(step!.action).toBe('find');
      expect(step!.target).toBe(expectedTarget);
    });
  });

  describe('type action', () => {
    it.each([
      ['Type hello world', 'hello world'],
      ['type my_password123', 'my_password123'],
      ['Enter john@example.com', 'john@example.com'],
      ['enter the search query', 'the search query'],
      ['Input a new task name', 'a new task name'],
      ['input 42', '42'],
    ])('parses "%s" → type target "%s"', (narration, expectedTarget) => {
      const step = parseStepFromNarration(narration);
      expect(step).not.toBeNull();
      expect(step!.action).toBe('type');
      expect(step!.target).toBe(expectedTarget);
    });
  });

  describe('wait action', () => {
    it.each([
      ['Wait 5 seconds', '5 seconds'],
      ['wait for the page to load', 'for the page to load'],
      ['Wait until the spinner disappears', 'until the spinner disappears'],
    ])('parses "%s" → wait target "%s"', (narration, expectedTarget) => {
      const step = parseStepFromNarration(narration);
      expect(step).not.toBeNull();
      expect(step!.action).toBe('wait');
      expect(step!.target).toBe(expectedTarget);
    });
  });

  describe('extract action', () => {
    it.each([
      ['Extract the price', 'the price'],
      ['extract all email addresses', 'all email addresses'],
      ['Grab the title text', 'the title text'],
      ['grab order number', 'order number'],
      ['Copy the confirmation code', 'the confirmation code'],
      ['copy that value', 'that value'],
    ])('parses "%s" → extract target "%s"', (narration, expectedTarget) => {
      const step = parseStepFromNarration(narration);
      expect(step).not.toBeNull();
      expect(step!.action).toBe('extract');
      expect(step!.target).toBe(expectedTarget);
      expect(step!.description).toBe(narration);
    });
  });

  describe('polite/prefixed phrasing', () => {
    it.each([
      ['Please click the submit button', 'click', 'the submit button'],
      ['Can you open https://example.com', 'navigate', 'https://example.com'],
      ['Now type hello', 'type', 'hello'],
      ['Then find the login form', 'find', 'the login form'],
      ['Please navigate to settings', 'navigate', 'settings'],
      ['Next, click Save', 'click', 'Save'],
      ['And then wait 5 seconds', 'wait', '5 seconds'],
    ])('parses "%s" → action "%s" target "%s"', (narration, expectedAction, expectedTarget) => {
      const step = parseStepFromNarration(narration);
      expect(step).not.toBeNull();
      expect(step!.action).toBe(expectedAction);
      expect(step!.target).toBe(expectedTarget);
      expect(step!.description).toBe(narration);
    });
  });

  describe('scroll action', () => {
    it.each([
      ['Scroll down', 'down'],
      ['scroll to the bottom', 'to the bottom'],
      ['Scroll up to the top', 'up to the top'],
    ])('parses "%s" → navigate target "%s"', (narration, expectedTarget) => {
      const step = parseStepFromNarration(narration);
      expect(step).not.toBeNull();
      expect(step!.action).toBe('navigate');
      expect(step!.target).toBe(expectedTarget);
      expect(step!.description).toBe(narration);
    });
  });

  describe('select/choose action', () => {
    it.each([
      ['Select the dropdown', 'the dropdown'],
      ['select option B', 'option B'],
      ['Choose the first item', 'the first item'],
      ['choose Premium plan', 'Premium plan'],
    ])('parses "%s" → click target "%s"', (narration, expectedTarget) => {
      const step = parseStepFromNarration(narration);
      expect(step).not.toBeNull();
      expect(step!.action).toBe('click');
      expect(step!.target).toBe(expectedTarget);
      expect(step!.description).toBe(narration);
    });
  });

  describe('unrecognized narrations return null', () => {
    it.each([
      'Hmm let me think',
      'Then you should see',
      '',
      '   ',
      'the end',
      'done',
      'nevermind',
    ])('returns null for "%s"', (narration) => {
      expect(parseStepFromNarration(narration)).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('handles leading/trailing whitespace', () => {
      const step = parseStepFromNarration('  Go to alto.com  ');
      expect(step).not.toBeNull();
      expect(step!.action).toBe('navigate');
    });

    it('is case-insensitive for action keywords', () => {
      const step = parseStepFromNarration('GO TO example.com');
      expect(step).not.toBeNull();
      expect(step!.action).toBe('navigate');
    });

    it('preserves original narration in description field', () => {
      const narration = 'Navigate to https://Example.COM/Path';
      const step = parseStepFromNarration(narration);
      expect(step!.description).toBe(narration);
    });

    it('handles targets with special characters', () => {
      const step = parseStepFromNarration(
        'Go to https://site.com/path?q=a&b=c#section',
      );
      expect(step!.target).toBe('https://site.com/path?q=a&b=c#section');
    });

    it('handles single-word targets', () => {
      const step = parseStepFromNarration('Click Submit');
      expect(step!.target).toBe('Submit');
    });
  });
});

// ────────────────────────────────────────────────────────────────
// buildProcedure — structure assembly
// ────────────────────────────────────────────────────────────────
describe('buildProcedure', () => {
  it('normalizes name to lowercase with underscores', () => {
    const proc = buildProcedure('Reorder Alto Refill', [], 'telegram_main');
    expect(proc.name).toBe('reorder_alto_refill');
  });

  it('collapses multiple spaces into single underscore', () => {
    const proc = buildProcedure('check  PR   status', [], 'g1');
    expect(proc.name).toBe('check_pr_status');
  });

  it('generates trigger from original name', () => {
    const proc = buildProcedure('Deploy Production', [], 'g1');
    expect(proc.trigger).toBe('user asks to Deploy Production');
  });

  it('sets acquisition to teach', () => {
    const proc = buildProcedure('test', [], 'g1');
    expect(proc.acquisition).toBe('teach');
  });

  it('includes learnedFrom with ISO timestamp and groupId', () => {
    const before = new Date().toISOString();
    const proc = buildProcedure('test', [], 'telegram_main');
    expect(proc.learnedFrom).toContain('teach mode in telegram_main');
    // Verify the timestamp portion is a valid ISO date
    const timestampPart = proc.learnedFrom.split(' teach mode')[0];
    expect(new Date(timestampPart).getTime()).not.toBeNaN();
  });

  it('preserves all steps in order', () => {
    const steps = [
      { action: 'navigate' as const, target: 'a.com', description: 'Go to a.com' },
      { action: 'click' as const, target: 'Login', description: 'Click Login' },
      { action: 'type' as const, target: 'user@test.com', description: 'Type user@test.com' },
      { action: 'click' as const, target: 'Submit', description: 'Click Submit' },
      { action: 'wait' as const, target: '3 seconds', description: 'Wait 3 seconds' },
    ];
    const proc = buildProcedure('login flow', steps, 'g1');
    expect(proc.steps).toHaveLength(5);
    expect(proc.steps[0].action).toBe('navigate');
    expect(proc.steps[4].action).toBe('wait');
    // details field must be populated for correct step rendering in executeProcedure
    expect(proc.steps[0].details).toBe('Go to a.com');
    expect(proc.steps[1].details).toBe('Click Login');
  });

  it('handles empty steps array', () => {
    const proc = buildProcedure('empty procedure', [], 'g1');
    expect(proc.steps).toHaveLength(0);
  });

  it('handles empty name', () => {
    const proc = buildProcedure('', [], 'g1');
    expect(proc.name).toBe('');
    expect(proc.trigger).toBe('user asks to ');
  });
});

// ────────────────────────────────────────────────────────────────
// saveProcedureViaIpc — IPC file dispatch
// ────────────────────────────────────────────────────────────────
describe('saveProcedureViaIpc', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('creates the tasks directory if it does not exist', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-ipc-'));
    const ipcDir = path.join(tmpDir, 'ipc');
    const proc = buildProcedure('test', [], 'g1');
    saveProcedureViaIpc(proc, ipcDir);

    expect(fs.existsSync(path.join(ipcDir, 'tasks'))).toBe(true);
  });

  it('writes a valid JSON file with learn_feedback type', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-ipc-'));
    const ipcDir = path.join(tmpDir, 'ipc');
    const steps = [
      { action: 'navigate' as const, target: 'a.com', description: 'Go to a.com' },
      { action: 'click' as const, target: 'Login', description: 'Click Login' },
    ];
    const proc = buildProcedure('login', steps, 'g1');
    saveProcedureViaIpc(proc, ipcDir);

    const tasksDir = path.join(ipcDir, 'tasks');
    const files = fs.readdirSync(tasksDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^teach-\d+-login\.json$/);

    const content = JSON.parse(fs.readFileSync(path.join(tasksDir, files[0]), 'utf-8'));
    expect(content.type).toBe('learn_feedback');
    expect(content.feedback).toContain('login');
    expect(content.feedback).toContain('2 steps');
    expect(content.procedure).toBeDefined();
    expect(content.procedure.name).toBe('login');
    expect(content.procedure.steps).toHaveLength(2);
    expect(content.procedure.acquisition).toBe('teach');
  });

  it('uses procedure name in filename', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-ipc-'));
    const proc = buildProcedure('reorder alto refill', [], 'g1');
    saveProcedureViaIpc(proc, tmpDir);

    const files = fs.readdirSync(path.join(tmpDir, 'tasks'));
    expect(files[0]).toContain('reorder_alto_refill');
  });

  it('handles multiple saves without overwriting', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-ipc-'));
    const proc1 = buildProcedure('proc one', [], 'g1');
    const proc2 = buildProcedure('proc two', [], 'g1');
    saveProcedureViaIpc(proc1, tmpDir);
    // Tiny delay to ensure different timestamps
    const start = Date.now();
    while (Date.now() === start) { /* spin */ }
    saveProcedureViaIpc(proc2, tmpDir);

    const files = fs.readdirSync(path.join(tmpDir, 'tasks'));
    expect(files).toHaveLength(2);
  });

  it('procedure in IPC payload has all required fields', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-ipc-'));
    const steps = [
      { action: 'navigate' as const, target: 'x.com', description: 'Go to x.com' },
    ];
    const proc = buildProcedure('quick check', steps, 'telegram_main');
    saveProcedureViaIpc(proc, tmpDir);

    const files = fs.readdirSync(path.join(tmpDir, 'tasks'));
    const content = JSON.parse(fs.readFileSync(path.join(tmpDir, 'tasks', files[0]), 'utf-8'));
    const p = content.procedure;

    expect(p).toHaveProperty('name');
    expect(p).toHaveProperty('trigger');
    expect(p).toHaveProperty('steps');
    expect(p).toHaveProperty('learnedFrom');
    expect(p).toHaveProperty('acquisition', 'teach');
  });
});

// ────────────────────────────────────────────────────────────────
// End-to-end: narrate → parse → build → save
// ────────────────────────────────────────────────────────────────
describe('end-to-end teach flow', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('full narration session produces correct IPC file', () => {
    const narrations = [
      'Go to https://alto.com/pharmacy',
      'Click on Sign In',
      'Type my_email@example.com',
      'Click Submit',
      'Wait for the page to load',
      'Find Lisinopril',
      'Click Reorder',
    ];

    const steps = narrations
      .map(parseStepFromNarration)
      .filter((s): s is NonNullable<typeof s> => s !== null);

    expect(steps).toHaveLength(7);
    expect(steps.map((s) => s.action)).toEqual([
      'navigate',
      'click',
      'type',
      'click',
      'wait',
      'find',
      'click',
    ]);

    const proc = buildProcedure('reorder alto refill', steps, 'telegram_main');
    expect(proc.name).toBe('reorder_alto_refill');
    expect(proc.steps).toHaveLength(7);

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-e2e-'));
    saveProcedureViaIpc(proc, tmpDir);

    const files = fs.readdirSync(path.join(tmpDir, 'tasks'));
    expect(files).toHaveLength(1);

    const content = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'tasks', files[0]), 'utf-8'),
    );
    expect(content.type).toBe('learn_feedback');
    expect(content.procedure.steps).toHaveLength(7);
    expect(content.procedure.steps[0].target).toBe(
      'https://alto.com/pharmacy',
    );
    expect(content.procedure.steps[5].target).toBe('Lisinopril');
    // details must be present so executeProcedure renders the description, not just the action name
    expect(content.procedure.steps[0].details).toBe('Go to https://alto.com/pharmacy');
  });

  it('mixed valid and invalid narrations only captures valid steps', () => {
    const narrations = [
      'Go to dashboard',
      'Then scroll down a bit',
      'Click the export button',
      'Hmm wait actually',
      'Wait 2 seconds',
      'done',
    ];

    const steps = narrations
      .map(parseStepFromNarration)
      .filter((s): s is NonNullable<typeof s> => s !== null);

    // "Then scroll down a bit" now parses as navigate (scroll→navigate after stripping "Then")
    expect(steps).toHaveLength(4);
    expect(steps.map((s) => s.action)).toEqual(['navigate', 'navigate', 'click', 'wait']);
  });
});
