/**
 * Non-blocking sudo cache check for use inside step children.
 *
 * Step children are spawned with stdio piped to the parent (runner.ts:123),
 * so any sudo call that needs to prompt for a password reads from /dev/null
 * and blocks forever — the user sees a clean spinner and an indefinite hang.
 * `nanoclaw.sh` primes the sudo cache visibly before the spinner starts, but
 * the cache can expire (default 15 min) during user-driven steps like Claude
 * OAuth. Step code that needs sudo should call `ensureSudoCached()` first
 * and bail with a clear message if it returns `expired`, instead of running
 * `sudo …` and hanging.
 */
import { execFileSync } from 'child_process';

export type SudoCacheState = 'cached' | 'expired' | 'unavailable';

export function ensureSudoCached(): SudoCacheState {
  if (process.platform === 'darwin') return 'cached'; // macOS path doesn't sudo from inside steps
  if (process.getuid?.() === 0) return 'cached'; // already root
  try {
    execFileSync('sudo', ['-n', 'true'], { stdio: 'ignore', timeout: 5000 });
    return 'cached';
  } catch {
    try {
      execFileSync('sudo', ['-V'], { stdio: 'ignore', timeout: 5000 });
      return 'expired';
    } catch {
      return 'unavailable';
    }
  }
}
