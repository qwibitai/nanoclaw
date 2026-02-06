#!/usr/bin/env node
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { platform } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const IMAGE_NAME = 'nanoclaw-agent';
const TAG = process.argv[2] || 'latest';
const isAppleContainer = platform() === 'darwin';
const runtime = isAppleContainer ? 'container' : 'docker';

console.log('Building NanoClaw agent container image...');
console.log(`Image: ${IMAGE_NAME}:${TAG}`);
console.log(`Runtime: ${runtime}`);
console.log('');

try {
  execSync(`${runtime} build -t ${IMAGE_NAME}:${TAG} .`, {
    cwd: __dirname,
    stdio: 'inherit',
  });

  console.log('');
  console.log('Build complete!');
  console.log(`Image: ${IMAGE_NAME}:${TAG}`);
  console.log('');
  console.log('Test with:');
  if (isAppleContainer) {
    console.log(`  echo '{"prompt":"What is 2+2?","groupFolder":"test","chatJid":"test@g.us","isMain":false}' | ${runtime} run -i ${IMAGE_NAME}:${TAG}`);
  } else {
    console.log(`  echo '{"prompt":"What is 2+2?","groupFolder":"test","chatJid":"test@g.us","isMain":false}' | ${runtime} run -i --rm ${IMAGE_NAME}:${TAG}`);
  }
} catch (err) {
  console.error('Build failed:', err.message);
  process.exit(1);
}
