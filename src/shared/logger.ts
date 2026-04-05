const LEVELS = { debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;
type Level = keyof typeof LEVELS;

const COLORS: Record<Level, string> = {
  debug: '\x1b[34m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  fatal: '\x1b[41m\x1b[37m',
};
const KEY_COLOR = '\x1b[35m';
const MSG_COLOR = '\x1b[36m';
const RESET = '\x1b[39m';
const FULL_RESET = '\x1b[0m';

const threshold =
  LEVELS[(Deno.env.get('LOG_LEVEL') as Level) || 'info'] ?? LEVELS.info;

const encoder = new TextEncoder();

function formatErr(err: unknown): string {
  if (err instanceof Error) {
    return `{\n      "type": "${err.constructor.name}",\n      "message": "${err.message}",\n      "stack":\n          ${err.stack}\n    }`;
  }
  return JSON.stringify(err);
}

function formatData(data: Record<string, unknown>): string {
  let out = '';
  for (const [k, v] of Object.entries(data)) {
    if (k === 'err') {
      out += `\n    ${KEY_COLOR}err${RESET}: ${formatErr(v)}`;
    } else {
      out += `\n    ${KEY_COLOR}${k}${RESET}: ${JSON.stringify(v)}`;
    }
  }
  return out;
}

function ts(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function log(
  level: Level,
  dataOrMsg: Record<string, unknown> | string,
  msg?: string,
): void {
  if (LEVELS[level] < threshold) return;
  const tag = `${COLORS[level]}${level.toUpperCase()}${level === 'fatal' ? FULL_RESET : RESET}`;
  const useStderr = LEVELS[level] >= LEVELS.warn;
  if (typeof dataOrMsg === 'string') {
    const line = `[${ts()}] ${tag} (${Deno.pid}): ${MSG_COLOR}${dataOrMsg}${RESET}\n`;
    if (useStderr) {
      Deno.stderr.writeSync(encoder.encode(line));
    } else {
      Deno.stdout.writeSync(encoder.encode(line));
    }
  } else {
    const line = `[${ts()}] ${tag} (${Deno.pid}): ${MSG_COLOR}${msg}${RESET}${formatData(dataOrMsg)}\n`;
    if (useStderr) {
      Deno.stderr.writeSync(encoder.encode(line));
    } else {
      Deno.stdout.writeSync(encoder.encode(line));
    }
  }
}

export const logger = {
  debug: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('debug', dataOrMsg, msg),
  info: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('info', dataOrMsg, msg),
  warn: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('warn', dataOrMsg, msg),
  error: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('error', dataOrMsg, msg),
  fatal: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('fatal', dataOrMsg, msg),
};

globalThis.addEventListener('error', (event) => {
  logger.fatal({ err: event.error }, 'Uncaught exception');
  Deno.exit(1);
});

globalThis.addEventListener('unhandledrejection', (event) => {
  logger.error({ err: event.reason }, 'Unhandled rejection');
});
