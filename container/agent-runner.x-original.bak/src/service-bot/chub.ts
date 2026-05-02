// Context Hub (chub) tools — search and retrieve LLM-optimized docs and skills.
// These run inside the NanoClaw container where chub is installed globally.

import { execFile } from 'node:child_process';

const CHUB_TIMEOUT = 15_000; // 15 seconds
const MAX_OUTPUT = 100 * 1024; // 100KB

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ChubExecutor = (args: string[]) => Promise<ExecResult>;

/**
 * Real executor — calls the `chub` CLI binary.
 * Tests should mock this.
 */
export const chubExec: ChubExecutor = (args: string[]): Promise<ExecResult> => {
  return new Promise((resolve) => {
    execFile('chub', args, {
      timeout: CHUB_TIMEOUT,
      maxBuffer: MAX_OUTPUT,
      env: { ...process.env, NO_COLOR: '1' },
    }, (error, stdout, stderr) => {
      if (error && 'killed' in error && error.killed) {
        resolve({
          stdout: stdout?.toString() ?? '',
          stderr: 'chub command timed out.',
          exitCode: 124,
        });
        return;
      }

      resolve({
        stdout: stdout?.toString() ?? '',
        stderr: stderr?.toString() ?? '',
        exitCode: error ? ((error as any).code as number | undefined) ?? 1 : 0,
      });
    });
  });
};

/**
 * Search the Context Hub registry for docs and skills.
 */
export async function chubSearch(
  query: string,
  exec: ChubExecutor,
  options?: { tags?: string; lang?: string; limit?: number },
): Promise<string> {
  const args = ['search', '--json'];

  if (query.trim()) {
    args.push(query.trim());
  }

  if (options?.tags) {
    args.push('--tags', options.tags);
  }
  if (options?.lang) {
    args.push('--lang', options.lang);
  }
  if (options?.limit) {
    args.push('--limit', String(Math.min(Math.max(options.limit, 1), 50)));
  }

  const result = await exec(args);

  if (result.exitCode !== 0) {
    return `Error searching Context Hub: ${result.stderr.trim() || result.stdout.trim()}`;
  }

  // Parse JSON output and format for readability
  try {
    const data = JSON.parse(result.stdout);
    if (!Array.isArray(data) || data.length === 0) {
      return `No results found${query ? ` for "${query}"` : ''}.`;
    }

    const lines = data.map((item: { id: string; type: string; language?: string; description?: string }) => {
      const lang = item.language ? `  [${item.language}]` : '';
      const type = item.type ? `  (${item.type})` : '';
      return `- **${item.id}**${type}${lang}\n  ${item.description ?? ''}`;
    });

    return `Found ${data.length} result(s):\n\n${lines.join('\n')}`;
  } catch {
    // Fallback: return raw output if not JSON
    return result.stdout.trim();
  }
}

/**
 * Fetch a doc or skill by ID from Context Hub.
 */
export async function chubGet(
  id: string,
  exec: ChubExecutor,
  options?: { lang?: string; full?: boolean },
): Promise<string> {
  if (!id.trim()) {
    return 'Error: doc/skill ID is required.';
  }

  const args = ['get', '--json', id.trim()];

  if (options?.lang) {
    args.push('--lang', options.lang);
  }
  if (options?.full) {
    args.push('--full');
  }

  const result = await exec(args);

  if (result.exitCode !== 0) {
    return `Error fetching "${id}": ${result.stderr.trim() || result.stdout.trim()}`;
  }

  // Parse JSON and return the content
  try {
    const data = JSON.parse(result.stdout);

    // chub get returns an array of fetched items
    if (Array.isArray(data) && data.length > 0) {
      const item = data[0];
      const header = `**${item.id}** (${item.type ?? 'doc'})`;
      const content = item.content ?? item.text ?? result.stdout;
      return `${header}\n\n${content}`;
    }

    // Single object
    if (data.content || data.text) {
      const header = `**${data.id ?? id}** (${data.type ?? 'doc'})`;
      return `${header}\n\n${data.content ?? data.text}`;
    }

    // Fallback
    return result.stdout.trim();
  } catch {
    // Not JSON — return raw content (some docs output raw text)
    return result.stdout.trim();
  }
}
