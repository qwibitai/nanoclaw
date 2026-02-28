// Merge into src/config.ts (add near other channel configuration exports)

// --- Signal configuration ---
export const SIGNAL_ACCOUNT = process.env.SIGNAL_ACCOUNT || '';
export const SIGNAL_HTTP_HOST = process.env.SIGNAL_HTTP_HOST || '127.0.0.1';
export const SIGNAL_HTTP_PORT = parseInt(process.env.SIGNAL_HTTP_PORT || '8080', 10);
export const SIGNAL_ALLOW_FROM = process.env.SIGNAL_ALLOW_FROM
  ? process.env.SIGNAL_ALLOW_FROM.split(',').map(s => s.trim())
  : [];
export const SIGNAL_ONLY = process.env.SIGNAL_ONLY === 'true';
