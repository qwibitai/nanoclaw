/**
 * Helpers for the Ollama MCP wrapper.
 *
 * Extracted so they can be unit-tested without importing ollama-mcp-stdio.ts
 * (which starts the MCP server on load).
 */
import fs from 'fs';
import path from 'path';

const DEFAULT_WORKSPACE_ROOT = '/workspace';
const WORKSPACE_LITERAL_PREFIX = '/workspace/';

/**
 * Resolve a path that the agent passed (e.g. an inbox attachment) to an
 * absolute path under `root`. Accepts:
 *   - workspace-relative paths: "inbox/<msgid>/photo.jpg"
 *   - absolute paths under the root
 *   - paths verbatim from the formatter ("/workspace/inbox/<msgid>/photo.jpg")
 *
 * Throws if the resolved path would escape `root`.
 */
export function resolveWorkspacePath(p: string, root: string = DEFAULT_WORKSPACE_ROOT): string {
  let cleaned = p;
  if (cleaned === '/workspace') {
    cleaned = '';
  } else if (cleaned.startsWith(WORKSPACE_LITERAL_PREFIX)) {
    cleaned = cleaned.slice(WORKSPACE_LITERAL_PREFIX.length);
  }

  const abs = path.resolve(root, cleaned);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`path escapes workspace: ${p}`);
  }
  return abs;
}

export interface GenerateArgs {
  model: string;
  prompt: string;
  system?: string;
  images?: string[];
}

/**
 * Build the JSON body for a POST /api/generate request, reading + base64-
 * encoding any image files referenced by `images`. Pure relative to the
 * filesystem at call time — no network calls.
 */
export function buildGenerateBody(
  args: GenerateArgs,
  root: string = DEFAULT_WORKSPACE_ROOT,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: args.model,
    prompt: args.prompt,
    stream: false,
  };
  if (args.system) {
    body.system = args.system;
  }
  if (args.images && args.images.length > 0) {
    body.images = args.images.map(p =>
      fs.readFileSync(resolveWorkspacePath(p, root)).toString('base64'),
    );
  }
  return body;
}
