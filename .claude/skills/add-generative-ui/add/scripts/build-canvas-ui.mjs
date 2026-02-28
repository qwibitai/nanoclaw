#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const rootDir = process.cwd();
const srcDir = path.join(rootDir, 'web', 'src');
const distDir = path.join(rootDir, 'web', 'dist');
const entryFile = path.join(srcDir, 'main.tsx');
const htmlFile = path.join(srcDir, 'index.html');
const cssFile = path.join(srcDir, 'styles.css');
const outFile = path.join(distDir, 'canvas-app.js');

function ensureExists(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing required file: ${path.relative(rootDir, filePath)}`);
  }
}

async function main() {
  ensureExists(entryFile);
  ensureExists(htmlFile);
  ensureExists(cssFile);

  fs.mkdirSync(distDir, { recursive: true });

  const esbuild = await import('esbuild');
  await esbuild.build({
    entryPoints: [entryFile],
    outfile: outFile,
    bundle: true,
    minify: true,
    sourcemap: false,
    target: ['es2022'],
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    legalComments: 'none',
  });

  fs.copyFileSync(htmlFile, path.join(distDir, 'index.html'));

  console.log('Canvas UI built at web/dist');
}

main().catch((err) => {
  console.error('Failed to build canvas UI:', err);
  process.exit(1);
});
