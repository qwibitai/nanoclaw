/**
 * X Integration - Script IO framework
 * Handles stdin/stdout for script execution
 */

export interface ScriptResult {
  success: boolean;
  message: string;
  data?: unknown;
}

/**
 * Read JSON input from stdin
 */
export async function readInput<T>(): Promise<T> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error(`Invalid JSON input: ${err}`));
      }
    });
    process.stdin.on('error', reject);
  });
}

/**
 * Write result to stdout as JSON
 */
export function writeResult(result: ScriptResult): void {
  console.log(JSON.stringify(result));
}

/**
 * Run script with error handling wrapper
 */
export async function runScript<T>(
  handler: (input: T) => Promise<ScriptResult>
): Promise<void> {
  try {
    const input = await readInput<T>();
    const result = await handler(input);
    writeResult(result);
  } catch (err) {
    writeResult({
      success: false,
      message: `Script execution failed: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }
}
