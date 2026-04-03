import { registerPlugin } from './registry.js';

registerPlugin({
  name: 'tailscale',
  containerEnvKeys: ['TAILSCALE_AUTH_KEY', 'TAILSCALE_HOSTNAME'],
  binaryInstall: {
    archive: 'https://pkgs.tailscale.com/stable/tailscale_1.96.4_amd64.tgz',
    extract: ['tailscale', 'tailscaled'],
    dest: '/usr/local/bin/',
    stripComponents: 1,
  },
});
