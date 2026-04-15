import { registerPlugin } from './registry.js';

registerPlugin({
  name: 'blogwatcher',
  binaryInstall: {
    archive: 'https://github.com/Hyaxia/blogwatcher/releases/download/v0.0.2/blogwatcher_0.0.2_linux_amd64.tar.gz',
    extract: ['blogwatcher'],
    dest: '/usr/local/bin/blogwatcher',
  },
});
