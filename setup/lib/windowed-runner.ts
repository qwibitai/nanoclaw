/**
 * Windowed step runner: parses Docker BuildKit step transitions out of the
 * child's output and reflects them on a single live header line — the
 * running label (default color) followed by the cleaned current step text
 * (cyan) and an `N/total` counter (cyan). Plus a stall detector that
 * interrupts with a "keep waiting or ask for help?" prompt when the
 * output stream goes silent for too long.
 *
 * Used for the container build (3–10 minutes on a fresh machine, no user
 * feedback with a plain spinner). Replaces the previous 3-line rolling
 * tail of raw build output, which mostly surfaced incidental noise
 * (`Reading package lists…`, `npm warn deprecated …`) instead of the
 * actual step transitions buried among them.
 *
 * Step parsing: BuildKit emits one line per step in the form
 *   `#N [stage-X  Y/Z] CMD args...`
 * We grab `Y`, `Z`, and `CMD args...`, strip a leading `RUN ` so apt /
 * pnpm commands read directly, and surface the result. Lines that don't
 * match are written to the raw log for post-mortem but not displayed —
 * which is the whole point.
 *
 * Stall detection: a silence timer resets on every new line. When it hits
 * STALL_THRESHOLD_MS we pause the render, show `offerClaudeAssist` with
 * the step's raw log, and either resume (user said "keep waiting") or
 * let the step run its course while giving them the exit path.
 */
import * as p from '@clack/prompts';
import k from 'kleur';

import { offerClaudeAssist } from './claude-assist.js';
import { emit as phEmit } from './diagnostics.js';
import type { StepResult, SpinnerLabels } from './runner.js';
import { dumpTranscriptOnFailure, spawnStep, writeStepEntry } from './runner.js';
import * as setupLog from '../logs.js';
import { brand, brandBody, fitToWidth } from './theme.js';

const SPINNER_FRAMES = ['◒', '◐', '◓', '◑'];
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const STALL_THRESHOLD_MS = 60_000;

/**
 * BuildKit step-transition line. Captures `Y` (step number), `Z` (total
 * within the stage), and the rest of the line (the Dockerfile command
 * verb + args). Tolerates the variable whitespace BuildKit emits between
 * the stage name and the X/Y counter.
 */
const BUILDKIT_STEP_RE = /^#\d+\s+\[\S+\s+(\d+)\/(\d+)\]\s+(.+)$/;

function cleanStepText(raw: string): string {
  // Strip `RUN ` so the underlying command (apt-get, pnpm, etc.) reads
  // first. Other verbs (FROM, COPY, WORKDIR, ARG, ENV) carry meaning on
  // their own — e.g. "FROM node:20-bookworm-slim" is more useful than
  // "node:20-bookworm-slim" alone — so we leave those intact.
  return raw.startsWith('RUN ') ? raw.slice(4) : raw;
}

/**
 * Run a step with the live BuildKit-step header + stall detector. Same
 * signature shape as `runQuietStep` (so auto.ts can swap them), but
 * reflects the child's docker-build progress on a single live line.
 */
export async function runWindowedStep(
  stepName: string,
  labels: SpinnerLabels,
  extra: string[] = [],
): Promise<StepResult & { rawLog: string; durationMs: number }> {
  const rawLog = setupLog.stepRawLog(stepName);
  const start = Date.now();
  phEmit('step_started', { step: stepName });

  const result = await runUnderWindow(stepName, labels, extra, rawLog);

  const durationMs = Date.now() - start;
  writeStepEntry(stepName, result, durationMs, rawLog);
  phEmit('step_completed', {
    step: stepName,
    status: outcomeStatus(result),
    duration_ms: durationMs,
  });
  return { ...result, rawLog, durationMs };
}

function outcomeStatus(result: StepResult): 'success' | 'skipped' | 'failed' {
  const rawStatus = result.terminal?.fields.STATUS;
  if (!result.ok) return 'failed';
  return rawStatus === 'skipped' ? 'skipped' : 'success';
}

/**
 * The core render + spawn loop. Kept separate from `runWindowedStep` so
 * the logging bookkeeping (writeStepEntry, phEmit) lives with the
 * public-facing wrapper and this function stays focused on terminal IO.
 */
async function runUnderWindow(
  stepName: string,
  labels: SpinnerLabels,
  extra: string[],
  rawLog: string,
): Promise<StepResult> {
  const out = process.stdout;
  let frameIdx = 0;
  let lastLineAt = Date.now();
  let stallPromptActive = false;
  let handledStall = false;
  let currentStepText = '';
  let currentStepNum = 0;
  let currentStepTotal = 0;

  const renderHeader = (): string => {
    const icon = SPINNER_FRAMES[frameIdx % SPINNER_FRAMES.length];
    // Before any BuildKit step transition lands (very early in the build,
    // and during the `[internal] load …` phases that don't carry an X/Y
    // counter), just show the running label as the spinner copy. Once
    // we've seen a transition, swap the trailing ellipsis for the
    // step text + counter.
    if (currentStepTotal === 0) {
      return `${k.cyan(icon)}  ${labels.running}`;
    }
    const labelStem = labels.running.replace(/…$/, '');
    const stepText = brand(currentStepText);
    const counter = brand(`${currentStepNum}/${currentStepTotal}`);
    const sep = k.dim('·');
    return fitToWidth(
      `${k.cyan(icon)}  ${labelStem}: ${stepText} ${sep} ${counter}`,
      '',
    );
  };

  const redraw = (): void => {
    if (stallPromptActive) return;
    out.write('\x1b[1A');
    out.write(`\x1b[2K${renderHeader()}\n`);
  };

  const clearBlock = (): void => {
    out.write('\x1b[1A');
    out.write('\x1b[2K\n');
    out.write('\x1b[1A');
  };

  out.write(HIDE_CURSOR);
  out.write('\n');
  redraw();

  const restoreCursorOnExit = (): void => {
    out.write(SHOW_CURSOR);
  };
  process.once('exit', restoreCursorOnExit);

  const frameTick = setInterval(() => {
    frameIdx++;
    redraw();
  }, 250);

  const stallCheck = setInterval(() => {
    if (handledStall || stallPromptActive) return;
    if (Date.now() - lastLineAt < STALL_THRESHOLD_MS) return;
    handledStall = true;
    void handleStall(stepName, rawLog, {
      pauseRender: () => {
        stallPromptActive = true;
        clearBlock();
        out.write(SHOW_CURSOR);
      },
      resumeRender: () => {
        out.write(HIDE_CURSOR);
        out.write('\n');
        stallPromptActive = false;
        lastLineAt = Date.now();
        redraw();
      },
    });
  }, 5_000);

  const onLine = (line: string): void => {
    lastLineAt = Date.now();
    // Strip ANSI escape sequences — BuildKit writes colored progress
    // codes that would otherwise leak into our regex match and the
    // rendered header.
    // eslint-disable-next-line no-control-regex
    const clean = line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim();
    const m = clean ? BUILDKIT_STEP_RE.exec(clean) : null;
    if (m) {
      currentStepNum = parseInt(m[1], 10);
      currentStepTotal = parseInt(m[2], 10);
      currentStepText = cleanStepText(m[3]);
    }
    redraw();
  };

  const result = await spawnStep(stepName, extra, () => {}, rawLog, onLine);

  clearInterval(frameTick);
  clearInterval(stallCheck);
  clearBlock();
  out.write(SHOW_CURSOR);
  process.off('exit', restoreCursorOnExit);

  if (result.ok) {
    const isSkipped = result.terminal?.fields.STATUS === 'skipped';
    const msg = isSkipped && labels.skipped ? labels.skipped : labels.done;
    p.log.success(brand(fitToWidth(msg, '')));
  } else {
    const failMsg = labels.failed ?? labels.running.replace(/…$/, ' failed');
    p.log.error(fitToWidth(failMsg, ''));
    dumpTranscriptOnFailure(result.transcript);
  }
  return result;
}

async function handleStall(
  stepName: string,
  rawLog: string,
  render: { pauseRender: () => void; resumeRender: () => void },
): Promise<void> {
  render.pauseRender();
  p.log.warn(
    brandBody(`This looks stuck — no output from the ${stepName} step for the last 60 seconds.`),
  );
  phEmit('step_stalled', { step: stepName });

  const { ensureAnswer } = await import('./runner.js');
  const { brightSelect } = await import('./bright-select.js');

  const choice = ensureAnswer(
    await brightSelect<'wait' | 'help'>({
      message: "What now?",
      options: [
        {
          value: 'wait',
          label: "Keep waiting",
          hint: "large images can take 5–10 minutes",
        },
        {
          value: 'help',
          label: 'Ask Claude to take a look',
          hint: 'reads the raw build log and suggests a fix',
        },
      ],
    }),
  );

  if (choice === 'help') {
    // offerClaudeAssist runs its own spinner and may propose a fix command.
    // We don't attempt to restart the stalled build from here — if Claude
    // proposes a command the user accepts, they can retry setup afterwards.
    await offerClaudeAssist({
      stepName,
      msg: `The ${stepName} step has produced no output for 60 seconds.`,
      hint: 'It may be hung on a slow network pull or a failing Dockerfile step.',
      rawLogPath: rawLog,
    });
    // Keep the spinner going — the underlying process is still running,
    // and cancelling it here would race with Claude's investigation. The
    // user can Ctrl-C if they want to bail.
  }

  render.resumeRender();
}
