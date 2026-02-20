# Shabbat Mode Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create a NanoClaw skill (`/add-shabbat-mode`) that pauses all outbound activity during Shabbat and Yom Tov, queuing messages for processing afterward. Then apply it to this instance.

**Architecture:** A generator script uses `@hebcal/core` (dev dependency) to pre-compute 5 years of Shabbat/Yom Tov windows into a flat JSON file. At runtime, a lightweight module loads this file and exposes `isShabbatOrYomTov()` via binary search. Three guard points in the main loop, task scheduler, and IPC watcher skip processing when active. The whole feature is packaged as a NanoClaw skill using the skills-engine (see `.claude/skills/add-voice-transcription/` for reference pattern).

**Tech Stack:** `@hebcal/core` (dev dependency only), TypeScript, vitest, NanoClaw skills-engine

---

### Task 1: Create the skill skeleton

**Files:**
- Create: `.claude/skills/add-shabbat-mode/SKILL.md`
- Create: `.claude/skills/add-shabbat-mode/manifest.yaml`

**Step 1: Create manifest.yaml**

Create `.claude/skills/add-shabbat-mode/manifest.yaml`:

```yaml
skill: shabbat-mode
version: 1.0.0
description: "Pause all activity during Shabbat and Yom Tov"
core_version: 0.1.0
adds:
  - src/shabbat.ts
  - src/shabbat.test.ts
  - scripts/generate-zmanim.ts
modifies:
  - src/index.ts
  - src/task-scheduler.ts
  - src/ipc.ts
  - package.json
structured:
  npm_dev_dependencies:
    "@hebcal/core": "^5"
  npm_scripts:
    generate-zmanim: "tsx scripts/generate-zmanim.ts"
conflicts: []
depends: []
test: "npx vitest run src/shabbat.test.ts"
```

**Step 2: Create SKILL.md**

Create `.claude/skills/add-shabbat-mode/SKILL.md` with the full skill instructions (see Task 8 for content — write it last after all code is finalized).

**Step 3: Commit skeleton**

```bash
git add .claude/skills/add-shabbat-mode/manifest.yaml
git commit -m "feat: add shabbat-mode skill skeleton"
```

---

### Task 2: Create the zmanim generator script (skill `add/` file)

**Files:**
- Create: `.claude/skills/add-shabbat-mode/add/scripts/generate-zmanim.ts`

**Step 1: Write the generator script**

Create `.claude/skills/add-shabbat-mode/add/scripts/generate-zmanim.ts`:

```typescript
/**
 * Generate Shabbat and Yom Tov schedule for NanoClaw.
 *
 * Uses @hebcal/core to compute shkiya and tzeis times.
 * Outputs a flat JSON file of restricted windows to data/shabbat-schedule.json.
 *
 * Run: npm run generate-zmanim
 */
import fs from 'fs';
import path from 'path';
import { GeoLocation, Zmanim, HebrewCalendar, flags } from '@hebcal/core';

// Defaults — override via CLI args or edit before running
const LAT = parseFloat(process.env.SHABBAT_LAT || '40.669');
const LNG = parseFloat(process.env.SHABBAT_LNG || '-73.943');
const ELEVATION = parseFloat(process.env.SHABBAT_ELEVATION || '25');
const LOCATION_NAME = process.env.SHABBAT_LOCATION || 'Crown Heights, Brooklyn';
const TIMEZONE = process.env.SHABBAT_TIMEZONE || 'America/New_York';
const YEARS_TO_GENERATE = parseInt(process.env.SHABBAT_YEARS || '5', 10);
const TZEIS_BUFFER_MINUTES = parseInt(process.env.SHABBAT_BUFFER || '18', 10);
const OUTPUT_PATH = path.resolve(process.cwd(), 'data', 'shabbat-schedule.json');

interface ShabbatWindow {
  start: string;
  end: string;
  type: 'shabbat' | 'yomtov' | 'shabbat+yomtov';
  label: string;
}

const geo = new GeoLocation(LOCATION_NAME, LAT, LNG, ELEVATION, TIMEZONE);

function getShkiya(date: Date): Date {
  const zmanim = new Zmanim(geo, date);
  return zmanim.sunset();
}

function getTzeisWithBuffer(date: Date): Date {
  const zmanim = new Zmanim(geo, date);
  const tzeis = zmanim.tzeit(8.5);
  return new Date(tzeis.getTime() + TZEIS_BUFFER_MINUTES * 60 * 1000);
}

function generateWindows(startYear: number, endYear: number): ShabbatWindow[] {
  const rawWindows: ShabbatWindow[] = [];

  // Shabbat windows: Friday sunset → Saturday night
  const startDate = new Date(startYear, 0, 1);
  const endDate = new Date(endYear + 1, 0, 1);

  for (let d = new Date(startDate); d < endDate; d.setDate(d.getDate() + 1)) {
    if (d.getDay() === 5) {
      const friday = new Date(d);
      const saturday = new Date(d);
      saturday.setDate(saturday.getDate() + 1);
      rawWindows.push({
        start: getShkiya(friday).toISOString(),
        end: getTzeisWithBuffer(saturday).toISOString(),
        type: 'shabbat',
        label: 'Shabbat',
      });
    }
  }

  // Yom Tov windows
  for (let year = startYear; year <= endYear; year++) {
    const events = HebrewCalendar.calendar({
      year,
      isHebrewYear: false,
      il: false,
      mask: flags.CHAG,
    });

    for (const ev of events) {
      const gregDate = ev.getDate().greg();
      const erev = new Date(gregDate);
      erev.setDate(erev.getDate() - 1);
      rawWindows.push({
        start: getShkiya(erev).toISOString(),
        end: getTzeisWithBuffer(gregDate).toISOString(),
        type: 'yomtov',
        label: ev.getDesc(),
      });
    }
  }

  // Sort and merge overlapping windows
  rawWindows.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  const merged: ShabbatWindow[] = [];
  for (const w of rawWindows) {
    const last = merged[merged.length - 1];
    if (last && new Date(w.start).getTime() <= new Date(last.end).getTime()) {
      if (new Date(w.end).getTime() > new Date(last.end).getTime()) {
        last.end = w.end;
      }
      if (last.type !== w.type) last.type = 'shabbat+yomtov';
      last.label = `${last.label} / ${w.label}`;
    } else {
      merged.push({ ...w });
    }
  }

  return merged;
}

const now = new Date();
const startYear = now.getFullYear();
const endYear = startYear + YEARS_TO_GENERATE - 1;

console.log(`Generating Shabbat/Yom Tov schedule for ${startYear}-${endYear}...`);
console.log(`Location: ${LOCATION_NAME} (${LAT}, ${LNG})`);

const windows = generateWindows(startYear, endYear);

const schedule = {
  location: LOCATION_NAME,
  coordinates: [LAT, LNG],
  elevation: ELEVATION,
  timezone: TIMEZONE,
  tzeisBufferMinutes: TZEIS_BUFFER_MINUTES,
  generatedAt: now.toISOString(),
  expiresAt: new Date(endYear + 1, 0, 1).toISOString(),
  windowCount: windows.length,
  windows,
};

fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
fs.writeFileSync(OUTPUT_PATH, JSON.stringify(schedule, null, 2));

console.log(`Generated ${windows.length} windows`);
console.log(`Written to ${OUTPUT_PATH}`);
console.log(`Schedule valid until ${schedule.expiresAt}`);
```

**Step 2: Commit**

```bash
git add .claude/skills/add-shabbat-mode/add/
git commit -m "feat: add zmanim generator script to shabbat-mode skill"
```

---

### Task 3: Create the runtime module and tests (skill `add/` files)

**Files:**
- Create: `.claude/skills/add-shabbat-mode/add/src/shabbat.ts`
- Create: `.claude/skills/add-shabbat-mode/add/src/shabbat.test.ts`

**Step 1: Write `src/shabbat.ts`**

Create `.claude/skills/add-shabbat-mode/add/src/shabbat.ts`:

```typescript
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

interface ShabbatWindow {
  start: string;
  end: string;
  type: 'shabbat' | 'yomtov' | 'shabbat+yomtov';
  label: string;
}

interface ShabbatSchedule {
  location: string;
  coordinates: number[];
  elevation: number;
  tzeisBufferMinutes: number;
  generatedAt: string;
  expiresAt: string;
  windowCount: number;
  windows: ShabbatWindow[];
}

let schedule: ShabbatSchedule | null = null;
let windowStarts: number[] = [];
let windowEnds: number[] = [];

const EXPIRY_WARNING_DAYS = 30;

function loadSchedule(s: ShabbatSchedule): void {
  schedule = s;
  windowStarts = s.windows.map((w) => new Date(w.start).getTime());
  windowEnds = s.windows.map((w) => new Date(w.end).getTime());
}

/**
 * Load the Shabbat schedule from disk. Called once at startup.
 * If the file doesn't exist, Shabbat mode is disabled (no restrictions).
 */
export function initShabbatSchedule(): void {
  const filePath = path.resolve(process.cwd(), 'data', 'shabbat-schedule.json');
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed: ShabbatSchedule = JSON.parse(raw);
    loadSchedule(parsed);
    logger.info(
      { windowCount: parsed.windowCount, expiresAt: parsed.expiresAt },
      'Shabbat schedule loaded',
    );

    const expiresAt = new Date(parsed.expiresAt).getTime();
    const warningThreshold = Date.now() + EXPIRY_WARNING_DAYS * 24 * 60 * 60 * 1000;
    if (expiresAt < warningThreshold) {
      logger.warn(
        { expiresAt: parsed.expiresAt },
        'Shabbat schedule expires soon! Run: npm run generate-zmanim',
      );
    }
  } catch {
    logger.info('No Shabbat schedule found, Shabbat mode disabled');
  }
}

/**
 * Check if the current time falls within a Shabbat or Yom Tov window.
 * Uses binary search for O(log n) lookup.
 */
export function isShabbatOrYomTov(): boolean {
  if (!schedule || windowStarts.length === 0) return false;

  const now = Date.now();

  let lo = 0;
  let hi = windowStarts.length - 1;
  let candidate = -1;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (windowStarts[mid] <= now) {
      candidate = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (candidate === -1) return false;
  return now < windowEnds[candidate];
}

/** @internal — for tests only */
export function _loadScheduleForTest(s: ShabbatSchedule): void {
  loadSchedule(s);
}
```

**Step 2: Write `src/shabbat.test.ts`**

Create `.claude/skills/add-shabbat-mode/add/src/shabbat.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isShabbatOrYomTov, _loadScheduleForTest } from './shabbat.js';

const TEST_SCHEDULE = {
  location: 'Test',
  coordinates: [40.669, -73.943],
  elevation: 25,
  tzeisBufferMinutes: 18,
  generatedAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2031-01-01T00:00:00.000Z',
  windowCount: 3,
  windows: [
    { start: '2026-02-20T17:20:00.000Z', end: '2026-02-21T23:45:00.000Z', type: 'shabbat' as const, label: 'Shabbat' },
    { start: '2026-02-27T17:28:00.000Z', end: '2026-02-28T23:50:00.000Z', type: 'shabbat' as const, label: 'Shabbat' },
    { start: '2026-03-20T17:40:00.000Z', end: '2026-03-22T23:55:00.000Z', type: 'shabbat+yomtov' as const, label: 'Shabbat / Pesach' },
  ],
};

describe('isShabbatOrYomTov', () => {
  beforeEach(() => { _loadScheduleForTest(TEST_SCHEDULE); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns true during a Shabbat window', () => {
    vi.setSystemTime(new Date('2026-02-20T20:00:00.000Z'));
    expect(isShabbatOrYomTov()).toBe(true);
  });

  it('returns true at exact start of window (shkiya)', () => {
    vi.setSystemTime(new Date('2026-02-20T17:20:00.000Z'));
    expect(isShabbatOrYomTov()).toBe(true);
  });

  it('returns false just before shkiya', () => {
    vi.setSystemTime(new Date('2026-02-20T17:19:59.999Z'));
    expect(isShabbatOrYomTov()).toBe(false);
  });

  it('returns true just before end of window', () => {
    vi.setSystemTime(new Date('2026-02-21T23:44:59.999Z'));
    expect(isShabbatOrYomTov()).toBe(true);
  });

  it('returns false at exact end of window (tzeis + 18)', () => {
    vi.setSystemTime(new Date('2026-02-21T23:45:00.000Z'));
    expect(isShabbatOrYomTov()).toBe(false);
  });

  it('returns false on a weekday', () => {
    vi.setSystemTime(new Date('2026-02-24T12:00:00.000Z'));
    expect(isShabbatOrYomTov()).toBe(false);
  });

  it('returns true during a merged shabbat+yomtov window', () => {
    vi.setSystemTime(new Date('2026-03-21T12:00:00.000Z'));
    expect(isShabbatOrYomTov()).toBe(true);
  });

  it('returns false before any windows', () => {
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    expect(isShabbatOrYomTov()).toBe(false);
  });

  it('returns false after all windows', () => {
    vi.setSystemTime(new Date('2027-01-01T00:00:00.000Z'));
    expect(isShabbatOrYomTov()).toBe(false);
  });
});
```

**Step 3: Commit**

```bash
git add .claude/skills/add-shabbat-mode/add/src/
git commit -m "feat: add shabbat runtime module and tests to skill"
```

---

### Task 4: Create the modify patches (skill `modify/` files)

These are the three-way merge files for `index.ts`, `task-scheduler.ts`, and `ipc.ts`. Follow the same pattern as the voice-transcription skill: the `modify/` directory contains the patched version of each file plus an `.intent.md` explaining the changes.

**Files:**
- Create: `.claude/skills/add-shabbat-mode/modify/src/index.ts` (copy of current file with Shabbat guards added)
- Create: `.claude/skills/add-shabbat-mode/modify/src/index.ts.intent.md`
- Create: `.claude/skills/add-shabbat-mode/modify/src/task-scheduler.ts` (copy with guard added)
- Create: `.claude/skills/add-shabbat-mode/modify/src/task-scheduler.ts.intent.md`
- Create: `.claude/skills/add-shabbat-mode/modify/src/ipc.ts` (copy with guard added)
- Create: `.claude/skills/add-shabbat-mode/modify/src/ipc.ts.intent.md`

**Step 1: Create modified `src/index.ts`**

Copy current `src/index.ts` and add these changes:
- Add import: `import { initShabbatSchedule, isShabbatOrYomTov } from './shabbat.js';`
- In `main()`, after `loadState()`: add `initShabbatSchedule();`
- In `processGroupMessages()`, after `if (!group) return true;`: add early return if `isShabbatOrYomTov()`
- In `startMessageLoop()`, inside `if (messages.length > 0)` after cursor advance: wrap the dedup+processing block in `if (!isShabbatOrYomTov()) { ... }` with a debug log in the else branch

**Step 2: Create `src/index.ts.intent.md`**

```markdown
# Intent: src/index.ts modifications

## What changed
Added Shabbat/Yom Tov guards to prevent message processing and agent invocation during restricted times.

## Key sections

### Imports (top of file)
- Added: `initShabbatSchedule`, `isShabbatOrYomTov` from `./shabbat.js`

### main() function
- Added: `initShabbatSchedule()` call after `loadState()` to load the schedule at startup

### processGroupMessages()
- Added: early return `if (isShabbatOrYomTov())` after group existence check
- Returns `true` (success) to prevent retries, but does NOT advance `lastAgentTimestamp`
- Messages remain unprocessed and queue naturally for post-Shabbat pickup

### startMessageLoop()
- Added: `if (!isShabbatOrYomTov())` guard wrapping the message dedup and processing block
- The "seen" cursor (`lastTimestamp`) still advances to prevent re-logging
- The per-group cursor (`lastAgentTimestamp`) stays un-advanced so messages queue

## Invariants (must-keep)
- All existing message handling, trigger logic, piping to active containers unchanged
- Connection lifecycle unchanged
- State save/load unchanged
- Recovery logic unchanged
- GroupQueue interaction unchanged
```

**Step 3: Create modified `src/task-scheduler.ts`**

Copy current `src/task-scheduler.ts` and add:
- Add import: `import { isShabbatOrYomTov } from './shabbat.js';`
- In `startSchedulerLoop()` loop function, after `getDueTasks()`: add early return if `isShabbatOrYomTov()` (tasks stay due, not rescheduled)

**Step 4: Create `src/task-scheduler.ts.intent.md`**

```markdown
# Intent: src/task-scheduler.ts modifications

## What changed
Added Shabbat/Yom Tov guard to skip scheduled task execution during restricted times.

## Key sections

### Imports (top of file)
- Added: `isShabbatOrYomTov` from `./shabbat.js`

### startSchedulerLoop() → loop()
- Added: early return after `getDueTasks()` if `isShabbatOrYomTov()`
- Due tasks are NOT rescheduled — `next_run` stays unchanged
- Tasks fire on the first scheduler poll after Shabbat ends
- Debug log when skipping due tasks

## Invariants (must-keep)
- All existing task execution, cron parsing, error handling unchanged
- Task status checks (paused/cancelled) unchanged
- Queue interaction unchanged
- Idle timeout handling unchanged
```

**Step 5: Create modified `src/ipc.ts`**

Copy current `src/ipc.ts` and add:
- Add import: `import { isShabbatOrYomTov } from './shabbat.js';`
- In `processIpcFiles()`, before the `for (const sourceGroup of groupFolders)` loop: add early return if `isShabbatOrYomTov()` (IPC files remain on disk)

**Step 6: Create `src/ipc.ts.intent.md`**

```markdown
# Intent: src/ipc.ts modifications

## What changed
Added Shabbat/Yom Tov guard to skip IPC message processing during restricted times.

## Key sections

### Imports (top of file)
- Added: `isShabbatOrYomTov` from `./shabbat.js`

### processIpcFiles()
- Added: early return before group folder loop if `isShabbatOrYomTov()`
- IPC message files stay on disk untouched
- They get processed on the first poll after Shabbat ends

## Invariants (must-keep)
- All existing IPC message authorization unchanged
- Task IPC processing unchanged
- Group registration via IPC unchanged
- Error handling and error directory logic unchanged
```

**Step 7: Commit**

```bash
git add .claude/skills/add-shabbat-mode/modify/
git commit -m "feat: add modify patches for shabbat-mode skill"
```

---

### Task 5: Write the SKILL.md

**Files:**
- Create: `.claude/skills/add-shabbat-mode/SKILL.md`

Write the SKILL.md following the pattern from `add-voice-transcription/SKILL.md`. It should cover:

1. **Pre-flight**: Check `.nanoclaw/state.yaml` for existing application
2. **Ask the user**: Location (lat/lng/timezone), tzeis buffer minutes (default 18)
3. **Apply code changes**: `npx tsx scripts/apply-skill.ts .claude/skills/add-shabbat-mode`
4. **Validate**: `npm test && npm run build`
5. **Generate schedule**: `npm run generate-zmanim`
6. **Build and restart**: `npm run build && systemctl --user restart nanoclaw` (Linux) or `launchctl kickstart` (macOS)
7. **Verify**: Check logs for "Shabbat schedule loaded"
8. **Troubleshooting**: Common issues (missing schedule file, expired schedule, regeneration)

**Step 1: Write SKILL.md**

(Write the full SKILL.md content)

**Step 2: Commit**

```bash
git add .claude/skills/add-shabbat-mode/SKILL.md
git commit -m "feat: add SKILL.md for shabbat-mode skill"
```

---

### Task 6: Apply the skill to this instance

**Step 1: Initialize skills system if needed**

```bash
npx tsx scripts/apply-skill.ts --init
```

**Step 2: Apply the skill**

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-shabbat-mode
```

**Step 3: Install dev dependency**

```bash
npm install --save-dev @hebcal/core
```

**Step 4: Run tests**

```bash
npx vitest run src/shabbat.test.ts
```

Expected: All 9 tests pass

**Step 5: Run full test suite**

```bash
npx vitest run
```

Expected: All tests pass

**Step 6: Build**

```bash
npm run build
```

Expected: Clean build

**Step 7: Commit the applied skill**

```bash
git add -A
git commit -m "feat: apply shabbat-mode skill to this instance"
```

---

### Task 7: Generate the zmanim schedule and deploy

**Step 1: Generate schedule**

```bash
npm run generate-zmanim
```

Expected: `data/shabbat-schedule.json` with 300+ windows

**Step 2: Sanity-check output**

Verify:
- Has 300+ windows
- First upcoming Friday window starts at correct shkiya time for Crown Heights
- Yom Tov events present (Rosh Hashana, Pesach, etc.)
- Multi-day events merged (2-day Yom Tov = one window)
- Adjacent Shabbat+Yom Tov merged

**Step 3: Restart service**

Linux: `systemctl --user restart nanoclaw`
macOS: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`

**Step 4: Verify in logs**

Check for "Shabbat schedule loaded" with window count.

```bash
grep -i shabbat logs/nanoclaw.log | tail -5
```

**Step 5: Commit schedule**

```bash
git add data/shabbat-schedule.json
git commit -m "feat: generate 5-year shabbat schedule for Crown Heights"
```

**Step 6: Push to fork**

```bash
git push origin main
```
