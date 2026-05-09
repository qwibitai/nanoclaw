/**
 * Detect whether a given directory is a NanoClaw v1 install, v2 install,
 * mixed (half-migrated), or fresh (nothing yet).
 *
 * Read-only. No mutation.
 */
import fs from 'fs';
import path from 'path';

export type InstallKind = 'v1' | 'v2' | 'mixed' | 'fresh';

export interface Verdict {
  kind: InstallKind;
  v1DbPath: string | null; // store/messages.db — present iff v1 or mixed
  v2DbPath: string | null; // data/v2.db — present iff v2 or mixed
  hasPnpmManaged: boolean; // packageManager key in package.json
  packageVersion: string | null;
  reasons: string[]; // human-readable narrative for the verdict
}

export function detectInstall(projectRoot: string): Verdict {
  const reasons: string[] = [];
  const v1Db = path.join(projectRoot, 'store', 'messages.db');
  const v2Db = path.join(projectRoot, 'data', 'v2.db');
  const pkg = path.join(projectRoot, 'package.json');

  const v1 = fs.existsSync(v1Db);
  const v2 = fs.existsSync(v2Db);
  if (v1) reasons.push(`v1 DB present at store/messages.db`);
  if (v2) reasons.push(`v2 DB present at data/v2.db`);

  let hasPnpmManaged = false;
  let packageVersion: string | null = null;
  if (fs.existsSync(pkg)) {
    try {
      const json = JSON.parse(fs.readFileSync(pkg, 'utf-8')) as {
        version?: string;
        packageManager?: string;
      };
      hasPnpmManaged = !!json.packageManager?.startsWith('pnpm@');
      packageVersion = json.version ?? null;
      if (packageVersion) reasons.push(`package.json version=${packageVersion}`);
      if (hasPnpmManaged) reasons.push(`packageManager=${json.packageManager}`);
    } catch {
      /* malformed — not load-bearing */
    }
  }

  let kind: InstallKind;
  if (v1 && v2) kind = 'mixed';
  else if (v1) kind = 'v1';
  else if (v2) kind = 'v2';
  else kind = 'fresh';

  return {
    kind,
    v1DbPath: v1 ? v1Db : null,
    v2DbPath: v2 ? v2Db : null,
    hasPnpmManaged,
    packageVersion,
    reasons,
  };
}
