#!/usr/bin/env tsx
/**
 * Generate contract.json — a machine-readable manifest of the surfaces
 * NanoClaw exposes to verticals.
 *
 * Parses source files with targeted regex to extract declarations.
 * Output is deterministic (sorted keys, stable ordering).
 *
 * Usage:
 *   npm run contract:generate   — overwrites contract.json
 *   npm run contract:check      — exits non-zero if contract.json is stale
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');

function readFile(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf-8');
}

// 1. MCP Tools — extract server.tool() calls
function extractMcpTools(): string[] {
  const content = readFile('container/agent-runner/src/ipc-mcp-stdio.ts');
  const tools: string[] = [];
  const re = /server\.tool\(\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    tools.push(match[1]);
  }
  return tools.sort();
}

// 2. IPC Types — extract case labels from processTaskIpc switch
function extractIpcTypes(): string[] {
  const content = readFile('src/ipc.ts');
  const types: string[] = [];
  const re = /case\s+['"]([^'"]+)['"]\s*:/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    types.push(match[1]);
  }
  // Also include base message types (handled in processMessageIpc, not switch cases)
  const messageTypes = ['message', 'image', 'document'];
  for (const t of messageTypes) {
    if (!types.includes(t)) types.push(t);
  }
  return [...new Set(types)].sort();
}

// 3. Mount Paths — extract containerPath from buildVolumeMounts
function extractMountPaths(): string[] {
  const content = readFile('src/container-runner.ts');
  const paths: string[] = [];
  const re = /containerPath:\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    // Skip the type definition line
    if (match[1] === '') continue;
    paths.push(match[1]);
  }
  return [...new Set(paths)].sort();
}

// 4. Environment Variables — extract -e args passed to containers
function extractEnvVars(): string[] {
  const content = readFile('src/container-runner.ts');
  const vars: string[] = [];
  // Match args.push('-e', 'VAR=...' or `VAR=...`)
  const re = /args\.push\(\s*'-e'\s*,\s*(?:['"`])([A-Z_]+)=/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    vars.push(match[1]);
  }
  // Also extract ENV from Dockerfile
  const dockerfile = readFile('container/Dockerfile');
  const envRe = /^ENV\s+([A-Z_]+)=/gm;
  while ((match = envRe.exec(dockerfile)) !== null) {
    vars.push(match[1]);
  }
  return [...new Set(vars)].sort();
}

// 5. Config Schema — extract config files read from vertical repos
function extractConfigSchema(): Record<string, string> {
  // These are documented in CLAUDE.md and read by the harness
  // The harness reads from config/ in the vertical mount
  return {
    'config/escalation.yaml':
      'Escalation policy: admins, gap types, priority signals, notification rules',
    'config/materials.json':
      'Material definitions, pricing (vertical-specific schema)',
  };
}

// 6. Case Sync Adapter Interface — extract method signatures
function extractCaseSyncAdapter(): string[] {
  const content = readFile('src/case-backend.ts');
  const methods: string[] = [];
  const re = /export interface CaseSyncAdapter\s*\{([^}]+)\}/s;
  const match = re.exec(content);
  if (match) {
    const body = match[1];
    const methodRe = /(\w+)\([^)]*\):\s*Promise<\w+>/g;
    let m;
    while ((m = methodRe.exec(body)) !== null) {
      methods.push(m[1]);
    }
  }
  return methods.sort();
}

// 7. Container Runtime — extract base image and system packages
function extractContainerRuntime(): {
  baseImage: string;
  systemPackages: string[];
  pythonPackages: string[];
  globalNpmPackages: string[];
} {
  const content = readFile('container/Dockerfile');

  // Base image
  const fromMatch = /^FROM\s+(\S+)/m.exec(content);
  const baseImage = fromMatch ? fromMatch[1] : 'unknown';

  // System packages from apt-get install
  const systemPackages: string[] = [];
  // Match the multi-line apt-get install block
  const aptBlock = content.match(
    /apt-get install -y\s*\\?\n?([\s\S]*?)(?:&&|$)/g,
  );
  if (aptBlock) {
    for (const block of aptBlock) {
      const pkgRe = /^\s+(\S+)\s*\\?\s*$/gm;
      let m;
      while ((m = pkgRe.exec(block)) !== null) {
        const pkg = m[1].replace(/\\$/, '').trim();
        if (
          pkg &&
          !pkg.startsWith('-') &&
          !pkg.startsWith('&') &&
          pkg !== 'install'
        ) {
          systemPackages.push(pkg);
        }
      }
      // Also match inline packages after -y
      const inlineRe = /install -y\s+(.+?)(?:\s*\\|$)/;
      const inlineMatch = inlineRe.exec(block);
      if (inlineMatch) {
        for (const p of inlineMatch[1].split(/\s+/)) {
          const clean = p.replace(/\\$/, '').trim();
          if (
            clean &&
            !clean.startsWith('-') &&
            !systemPackages.includes(clean)
          ) {
            systemPackages.push(clean);
          }
        }
      }
    }
  }

  // Python packages from pip3 install
  const pythonPackages: string[] = [];
  const pipLine = content.match(
    /pip3 install\s+[^\n]*?((?:[\w><=.\-]+\s*)+)$/m,
  );
  if (pipLine) {
    for (const pkg of pipLine[1].split(/\s+/)) {
      const clean = pkg.trim();
      if (clean && !clean.startsWith('-')) {
        pythonPackages.push(clean);
      }
    }
  }

  // Global npm packages
  const globalNpmPackages: string[] = [];
  const npmMatch = /npm install -g\s+(.+)/;
  const npmResult = npmMatch.exec(content);
  if (npmResult) {
    for (const pkg of npmResult[1].split(/\s+/)) {
      const clean = pkg.trim();
      if (clean) globalNpmPackages.push(clean);
    }
  }

  return {
    baseImage,
    systemPackages: [...new Set(systemPackages)].sort(),
    pythonPackages: pythonPackages.sort(),
    globalNpmPackages: globalNpmPackages.sort(),
  };
}

// Generate the full contract
export function generateContract(): object {
  const pkg = JSON.parse(readFile('package.json'));

  return {
    $schema: 'https://nanoclaw.dev/contract.schema.json',
    contractVersion: 1,
    harnessVersion: pkg.version,
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    surfaces: {
      mcpTools: extractMcpTools(),
      ipcTypes: extractIpcTypes(),
      mountPaths: extractMountPaths(),
      envVars: extractEnvVars(),
      configSchema: extractConfigSchema(),
      caseSyncAdapter: extractCaseSyncAdapter(),
      containerRuntime: extractContainerRuntime(),
    },
  };
}

// CLI entry point — only runs when executed directly, not when imported
const isCli = process.argv[1]
  ?.replace(/\.ts$/, '')
  .endsWith('generate-contract');
if (isCli) {
  const mode = process.argv[2] || 'generate';
  const contractPath = path.join(ROOT, 'contract.json');

  if (mode === 'check') {
    const generated = generateContract();
    // For check mode, compare surfaces only (ignore generatedAt and harnessVersion)
    let existing: Record<string, unknown>;
    try {
      existing = JSON.parse(fs.readFileSync(contractPath, 'utf-8'));
    } catch {
      console.error('contract.json not found. Run: npm run contract:generate');
      process.exit(1);
    }

    const genSurfaces = JSON.stringify(
      (generated as Record<string, unknown>).surfaces,
      null,
      2,
    );
    const existSurfaces = JSON.stringify(existing.surfaces, null, 2);

    if (genSurfaces !== existSurfaces) {
      console.error('contract.json is out of sync with source code.');
      console.error('Run: npm run contract:generate');
      console.error('');
      // Show what changed
      const genLines = genSurfaces.split('\n');
      const existLines = existSurfaces.split('\n');
      const maxLen = Math.max(genLines.length, existLines.length);
      for (let i = 0; i < maxLen; i++) {
        if (genLines[i] !== existLines[i]) {
          if (existLines[i]) console.error(`- ${existLines[i]}`);
          if (genLines[i]) console.error(`+ ${genLines[i]}`);
        }
      }
      process.exit(1);
    }

    console.log('contract.json is up to date.');
  } else {
    const contract = generateContract();
    fs.writeFileSync(contractPath, JSON.stringify(contract, null, 2) + '\n');
    console.log(
      `Generated contract.json (contractVersion: ${(contract as Record<string, unknown>).contractVersion})`,
    );
  }
}
