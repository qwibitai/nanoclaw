import fs from 'fs';
import path from 'path';

export interface McpLaunchSpec {
  command: string;
  args: string[];
}

export function resolveMcpServerLaunch(workerDir: string): McpLaunchSpec {
  const compiledEntry = path.join(workerDir, 'ipc-mcp-stdio.js');
  if (fs.existsSync(compiledEntry)) {
    return { command: process.execPath, args: [compiledEntry] };
  }

  const sourceEntry = path.join(workerDir, 'ipc-mcp-stdio.ts');
  if (!fs.existsSync(sourceEntry)) {
    throw new Error(`MCP server entrypoint not found in ${workerDir}`);
  }

  const cwd = process.cwd();
  const tsxLoader = path.join(cwd, 'node_modules', 'tsx', 'dist', 'loader.mjs');
  if (fs.existsSync(tsxLoader)) {
    return { command: process.execPath, args: ['--import', tsxLoader, sourceEntry] };
  }

  const localTsx = path.join(cwd, 'node_modules', '.bin', 'tsx');
  if (fs.existsSync(localTsx)) {
    return { command: localTsx, args: [sourceEntry] };
  }

  return { command: 'npx', args: ['tsx', sourceEntry] };
}
