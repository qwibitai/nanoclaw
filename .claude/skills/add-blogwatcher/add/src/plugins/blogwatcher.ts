import { registerPlugin } from './registry.js';

registerPlugin({
  name: 'blogwatcher',
  binaryInstall: {
    url: 'https://github.com/nicholasgasior/blogwatcher/releases/download/vX.Y.Z/blogwatcher-linux-amd64',
    dest: '/usr/local/bin/blogwatcher',
  },
});
