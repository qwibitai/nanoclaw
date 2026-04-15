import fs from 'fs';
import path from 'path';

import type pino from 'pino';

export interface JsonIpcFileProcessorOptions<T> {
  directory: string;
  errorDirectory: string;
  sourceGroup: string;
  createLogger: (file: string) => pino.Logger;
  handle: (data: T, log: pino.Logger) => Promise<void>;
}

export async function processJsonIpcDirectory<T>(
  options: JsonIpcFileProcessorOptions<T>,
): Promise<void> {
  if (!fs.existsSync(options.directory)) {
    return;
  }

  const files = fs
    .readdirSync(options.directory)
    .filter((file) => file.endsWith('.json'));

  for (const file of files) {
    const filePath = path.join(options.directory, file);
    const log = options.createLogger(file);

    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
      await options.handle(data, log);
      fs.unlinkSync(filePath);
    } catch (err) {
      log.error({ err }, 'Error processing IPC file');
      fs.mkdirSync(options.errorDirectory, { recursive: true });

      try {
        if (fs.existsSync(filePath)) {
          fs.renameSync(
            filePath,
            path.join(options.errorDirectory, `${options.sourceGroup}-${file}`),
          );
        }
      } catch (moveErr) {
        log.error({ err: moveErr }, 'Failed to quarantine IPC file');
      }
    }
  }
}
