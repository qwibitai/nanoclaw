/**
 * Side-effect-only bootstrap. Imported FIRST in server.ts so that
 * NanoClaw's `src/config.ts` sees the correct `process.cwd()` when its
 * top-level path constants (DATA_DIR, GROUPS_DIR, …) are evaluated.
 *
 * Without this: starting the server from any cwd that isn't the paraclaw
 * project root makes config.ts resolve `<cwd>/data` and `<cwd>/groups`,
 * which point at the wrong directories.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '../../..');
process.chdir(projectRoot);
