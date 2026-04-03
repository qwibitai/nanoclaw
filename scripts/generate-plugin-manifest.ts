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
  .map((p) => {
    const binaryInstall = p.binaryInstall as any;

    if (!binaryInstall || typeof binaryInstall !== 'object') {
      throw new Error(`Plugin "${p.name}" has an invalid binaryInstall configuration (expected an object).`);
    }

    if (
      !('dest' in binaryInstall) ||
      typeof binaryInstall.dest !== 'string' ||
      binaryInstall.dest.trim().length === 0
    ) {
      throw new Error(
        `Plugin "${p.name}" must specify a non-empty "dest" string in its binaryInstall configuration.`,
      );
    }

    const normalized = {
      ...binaryInstall,
      // Default extract to false if not explicitly set
      extract: binaryInstall.extract ?? false,
    };

    return { name: p.name, ...normalized };
  });
const outPath = path.join(process.cwd(), 'container', 'plugins', 'binaries.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(binaries, null, 2) + '\n');

console.log(
  `Generated plugins/binaries.json (${binaries.length} plugin${binaries.length !== 1 ? 's' : ''} with binaries)`,
);

// Generate directories.json from containerDirectories declarations
const directories = [...new Set(plugins.flatMap((p) => p.containerDirectories ?? []))];
const dirsPath = path.join(process.cwd(), 'container', 'plugins', 'directories.json');
fs.writeFileSync(dirsPath, JSON.stringify(directories, null, 2) + '\n');

console.log(
  `Generated plugins/directories.json (${directories.length} director${directories.length !== 1 ? 'ies' : 'y'})`,
);
