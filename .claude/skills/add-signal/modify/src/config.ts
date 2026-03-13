// Signal channel configuration
export const SIGNAL_PHONE_NUMBER =
  process.env.SIGNAL_PHONE_NUMBER || envConfig.SIGNAL_PHONE_NUMBER || '';

export const SIGNAL_SOCKET_PATH =
  process.env.SIGNAL_SOCKET_PATH ||
  envConfig.SIGNAL_SOCKET_PATH ||
  '/run/signal-cli/socket';
