/**
 * Container rebuild watcher.
 *
 * Polls every minute and rebuilds CONTAINER_IMAGE (from src/config.ts)
 * whenever the running image's commit label lags origin/main on files
 * under `container/`. Posts a completion message to an optional Discord
 * channel.
 *
 * Label-driven, not GitHub-event-driven — container/build.sh stamps the
 * repo HEAD SHA into the image as `nanoclaw.commit`, and we compare that
 * label against `git rev-parse origin/main`. Catches PR squash-merges,
 * direct pushes, force-pushes, hand-edits, and first runs where no image
 * exists yet. Timestamps were the old approach but Docker cache-hit
 * rebuilds don't advance them — labels do.
 *
 * If origin/main has new commits but none touch `container/`, the watcher
 * leaves the working tree alone — the user pulls when they want.
 */
import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';

import { CONTAINER_IMAGE, REPO_ROOT } from './config.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { log } from './log.js';

const execFileAsync = promisify(execFile);

const POLL_MS = 60_000;
// Use the same full reference container-runner.ts spawns from — CONTAINER_IMAGE
// resolves to `<install-slug-base>:<tag>` (default `:latest`). Pre-fix the
// watcher hardcoded `nanoclaw-agent:v2` (wrong base) and built with tag `v2`
// (wrong tag), so inspect + build targets + spawn target were all different
// images. Extract the tag from CONTAINER_IMAGE so build.sh gets the same one.
const IMAGE_REF = CONTAINER_IMAGE;
const tagColon = IMAGE_REF.lastIndexOf(':');
const IMAGE_TAG = tagColon >= 0 ? IMAGE_REF.slice(tagColon + 1) : 'latest';

type Notifier = (message: string) => Promise<void>;

let timer: NodeJS.Timeout | null = null;
let running = false;
let notify: Notifier | null = null;

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: REPO_ROOT, timeout: 30_000 });
  return stdout.trim();
}

const short = (sha: string): string => sha.slice(0, 7);

/**
 * Returns the running image's `nanoclaw.commit` label (stamped by
 * `container/build.sh`), or null when the image doesn't exist or wasn't
 * built by a version of build.sh that stamps the label.
 *
 * Previously we compared `Created` timestamps against `git log --before=...`,
 * but Docker's build cache reuses an existing image (same Created timestamp)
 * whenever all COPY'd inputs match — so a rebuild triggered by an
 * agent-runner/src change (mounted at runtime, not COPY'd) would succeed
 * quietly with the old timestamp and trap the watcher in a rebuild loop.
 * Commit labels advance with every successful build regardless of cache.
 */
async function imageCommitLabel(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      CONTAINER_RUNTIME_BIN,
      ['inspect', '--format', '{{index .Config.Labels "nanoclaw.commit"}}', IMAGE_REF],
      { timeout: 10_000 },
    );
    const label = stdout.trim();
    return label && label !== '<no value>' ? label : null;
  } catch {
    return null;
  }
}

interface StalenessCheck {
  stale: boolean;
  reason: string;
}

/**
 * Decide whether the image needs a rebuild. Always rebuilds when the image
 * doesn't exist or wasn't stamped with a commit label (old image from before
 * label support — treat as stale to force a fresh build that IS labeled).
 * Otherwise compares `imageCommit..origin/main` for files under `container/`.
 * A failed `git diff` is logged and treated as "stale" (fail-open) so a
 * transient git error doesn't silently suppress rebuilds.
 *
 * If origin/main is an ancestor of the image's label, the image already
 * contains everything origin/main has — not stale regardless of SHA mismatch.
 * Without this, a local HEAD ahead of origin/main (unpushed commits or a
 * locally-merged PR not yet on origin) loops every tick: backwards diff
 * `label..origin/main -- container/` is non-empty, rebuild stamps the same
 * label, repeat.
 */
async function checkStaleness(): Promise<StalenessCheck> {
  const [toSha, imageCommit] = await Promise.all([git('rev-parse', 'origin/main'), imageCommitLabel()]);
  if (!imageCommit) return { stale: true, reason: 'no image or missing nanoclaw.commit label' };
  if (imageCommit === toSha) return { stale: false, reason: `image at HEAD (${short(imageCommit)})` };
  try {
    await git('merge-base', '--is-ancestor', toSha, imageCommit);
    return {
      stale: false,
      reason: `image (${short(imageCommit)}) already includes origin/main (${short(toSha)})`,
    };
  } catch {
    /* origin/main has commits the image lacks — fall through to diff check */
  }
  let changed: string;
  try {
    changed = await git('diff', '--name-only', imageCommit, toSha, '--', 'container/');
  } catch (err) {
    log.warn('git diff failed in staleness check — treating as stale', { err });
    return { stale: true, reason: `git diff failed (range ${short(imageCommit)}..${short(toSha)})` };
  }
  if (!changed) return { stale: false, reason: `no container/ changes since ${short(imageCommit)}` };
  return { stale: true, reason: `container/ changed in ${short(imageCommit)}..${short(toSha)}` };
}

interface StepResult {
  ok: boolean;
  detail: string;
}

async function runStep(
  label: string,
  bin: string,
  args: string[],
  timeoutMs: number,
  maxErrChars: number,
  env?: NodeJS.ProcessEnv,
): Promise<StepResult> {
  try {
    await execFileAsync(bin, args, { cwd: REPO_ROOT, timeout: timeoutMs, env: env ?? process.env });
    return { ok: true, detail: label };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `${label} failed: ${msg.slice(0, maxErrChars)}` };
  }
}

async function pullAndBuild(): Promise<StepResult> {
  const pull = await runStep('git pull', 'git', ['pull', '--ff-only', 'origin', 'main'], 60_000, 300);
  if (!pull.ok) return pull;
  // Pass the exact image reference container-runner.ts spawns from. build.sh
  // honors CONTAINER_IMAGE_REF when set — without this, build.sh derives its
  // own base via container_image_base() and can drift from what we inspect if
  // CONTAINER_IMAGE is overridden (env var, custom install slug, etc.).
  return runStep('image rebuild', 'bash', [path.join(REPO_ROOT, 'container', 'build.sh'), IMAGE_TAG], 900_000, 500, {
    ...process.env,
    CONTAINER_IMAGE_REF: IMAGE_REF,
  });
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await execFileAsync('git', ['fetch', '--quiet', 'origin', 'main'], { cwd: REPO_ROOT, timeout: 30_000 });
    const check = await checkStaleness();
    if (!check.stale) {
      log.debug('Container image up to date', { reason: check.reason });
      return;
    }

    log.info('Container image stale — rebuilding', { reason: check.reason });
    const result = await pullAndBuild();
    const headSha = await git('rev-parse', 'HEAD').catch(() => '');
    log.info('Container rebuild result', {
      ok: result.ok,
      detail: result.detail,
      head: short(headSha),
    });
    // Notify only on failure. Successful auto-rebuilds are routine: the operator
    // already knows about their own commits, and the previous "✅ Container image
    // rebuilt (HEAD <sha>)" notification is mostly noise. Failures are surprising
    // and need attention (every new spawn would otherwise inherit the broken or
    // stale image).
    if (!result.ok && notify) {
      try {
        await notify(`❌ Container rebuild failed: ${result.detail}`);
      } catch (err) {
        log.warn('Container-rebuild watcher notify failed', { err });
      }
    }
  } catch (err) {
    log.error('Container-rebuild watcher tick failed', { err });
  } finally {
    running = false;
  }
}

export function startContainerRebuildWatcher(notifier?: Notifier): void {
  if (timer) return;
  notify = notifier ?? null;
  // First tick in 30s (let the service finish booting), then every POLL_MS.
  timer = setTimeout(function loop() {
    void tick().finally(() => {
      timer = setTimeout(loop, POLL_MS);
    });
  }, 30_000);
  log.info('Container-rebuild watcher started', { pollMs: POLL_MS, image: IMAGE_REF });
}

export function stopContainerRebuildWatcher(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  notify = null;
}
