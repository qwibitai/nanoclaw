#!/usr/bin/env tsx
/**
 * Generates plugins/binaries.json from the TypeScript plugin registry.
 * Run by container/build.sh before docker build.
 */
import fs from 'fs';
import path from 'path';

// Trigger plugin self-registrations, then read registry
import '../src/plugins/index.js';
import { getRegisteredPlugins } from '../src/plugins/registry.js';

const plugins = getRegisteredPlugins();
const binaries = plugins
  .filter((p) => p.binaryInstall !== undefined)
  .map((p) => ({ name: p.name, ...p.binaryInstall }));

const outPath = path.join(process.cwd(), 'container', 'plugins', 'binaries.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(binaries, null, 2) + '\n');

console.log(
  `Generated plugins/binaries.json (${binaries.length} plugin${binaries.length !== 1 ? 's' : ''} with binaries)`,
);
