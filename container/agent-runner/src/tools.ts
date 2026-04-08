/**
 * Tool definitions and executor for Ollama-based agent runner.
 * These tools replicate the core capabilities available via the Claude Agent SDK.
 * The container itself provides sandboxing (Docker isolation).
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { log } from './index.js';

const TOOL_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_SIZE = 512 * 1024; // 512KB

export interface OllamaToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<
        string,
        { type: string; description: string; default?: unknown }
      >;
      required: string[];
    };
  };
}

export const TOOL_DEFINITIONS: OllamaToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description:
        'Execute a bash command and return its output. Use for system commands, git, npm, etc.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The bash command to execute',
          },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a file from the filesystem. Returns the file contents.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the file to read',
          },
          offset: {
            type: 'number',
            description: 'Line number to start reading from (0-based)',
            default: 0,
          },
          limit: {
            type: 'number',
            description: 'Maximum number of lines to read',
            default: 2000,
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file, creating it if necessary.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the file to write',
          },
          content: {
            type: 'string',
            description: 'The content to write to the file',
          },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Replace a specific string in a file. The old_string must match exactly.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the file to edit',
          },
          old_string: {
            type: 'string',
            description: 'The exact string to find and replace',
          },
          new_string: {
            type: 'string',
            description: 'The replacement string',
          },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: 'Find files matching a glob pattern.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Glob pattern (e.g. "**/*.ts", "src/**/*.js")',
          },
          path: {
            type: 'string',
            description:
              'Directory to search in. Defaults to /workspace/group.',
          },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search file contents using a regex pattern.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Regular expression pattern to search for',
          },
          path: {
            type: 'string',
            description:
              'Directory or file to search in. Defaults to /workspace/group.',
          },
          glob: {
            type: 'string',
            description: 'File filter glob (e.g. "*.ts", "*.py")',
          },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the web using a query string. Returns search results with titles, URLs, and snippets.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description:
        'Fetch the contents of a URL. Returns the page text (HTML tags stripped).',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to fetch',
          },
        },
        required: ['url'],
      },
    },
  },
];

function truncate(text: string): string {
  if (text.length > MAX_OUTPUT_SIZE) {
    return (
      text.slice(0, MAX_OUTPUT_SIZE) +
      `\n... [truncated, ${text.length - MAX_OUTPUT_SIZE} bytes omitted]`
    );
  }
  return text;
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  log(`Executing tool: ${name}`);
  try {
    switch (name) {
      case 'bash':
        return truncate(executeBash(args));
      case 'read_file':
        return truncate(executeReadFile(args));
      case 'write_file':
        return executeWriteFile(args);
      case 'edit_file':
        return executeEditFile(args);
      case 'glob':
        return truncate(executeGlob(args));
      case 'grep':
        return truncate(executeGrep(args));
      case 'web_search':
        return truncate(await executeWebSearch(args));
      case 'web_fetch':
        return truncate(await executeWebFetch(args));
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Tool ${name} error: ${msg}`);
    return `Error: ${msg}`;
  }
}

function executeBash(args: Record<string, unknown>): string {
  const command = args.command as string;
  if (!command) return 'Error: command is required';
  try {
    const output = execSync(command, {
      cwd: '/workspace/group',
      timeout: TOOL_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_SIZE,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output || '(no output)';
  } catch (err) {
    const execErr = err as {
      stdout?: string;
      stderr?: string;
      message: string;
      status?: number;
    };
    const parts: string[] = [];
    if (execErr.status != null) parts.push(`Exit code: ${execErr.status}`);
    if (execErr.stdout) parts.push(execErr.stdout);
    if (execErr.stderr) parts.push(execErr.stderr);
    return parts.length > 0 ? parts.join('\n') : execErr.message;
  }
}

function executeReadFile(args: Record<string, unknown>): string {
  const filePath = args.path as string;
  if (!filePath) return 'Error: path is required';
  if (!fs.existsSync(filePath)) return `Error: file not found: ${filePath}`;

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const offset = (args.offset as number) || 0;
  const limit = (args.limit as number) || 2000;
  const slice = lines.slice(offset, offset + limit);

  return slice.map((line, i) => `${offset + i + 1}\t${line}`).join('\n');
}

function executeWriteFile(args: Record<string, unknown>): string {
  const filePath = args.path as string;
  const content = args.content as string;
  if (!filePath) return 'Error: path is required';
  if (content == null) return 'Error: content is required';

  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content);
  return `File written: ${filePath}`;
}

function executeEditFile(args: Record<string, unknown>): string {
  const filePath = args.path as string;
  const oldString = args.old_string as string;
  const newString = args.new_string as string;
  if (!filePath) return 'Error: path is required';
  if (oldString == null) return 'Error: old_string is required';
  if (newString == null) return 'Error: new_string is required';
  if (!fs.existsSync(filePath)) return `Error: file not found: ${filePath}`;

  const content = fs.readFileSync(filePath, 'utf-8');
  const occurrences = content.split(oldString).length - 1;
  if (occurrences === 0) return `Error: old_string not found in ${filePath}`;
  if (occurrences > 1)
    return `Error: old_string found ${occurrences} times in ${filePath}. Must be unique.`;

  const updated = content.replace(oldString, newString);
  fs.writeFileSync(filePath, updated);
  return `File edited: ${filePath}`;
}

function executeGlob(args: Record<string, unknown>): string {
  const pattern = args.pattern as string;
  const searchPath = (args.path as string) || '/workspace/group';
  if (!pattern) return 'Error: pattern is required';

  try {
    // Use find with shell glob — works without extra dependencies
    const output = execSync(
      `find ${searchPath} -path '*/${pattern}' -o -name '${pattern}' 2>/dev/null | head -200`,
      {
        encoding: 'utf-8',
        timeout: 10_000,
        maxBuffer: MAX_OUTPUT_SIZE,
      },
    );
    return output.trim() || 'No matches found';
  } catch {
    // Fallback: use bash globstar
    try {
      const output = execSync(
        `shopt -s globstar nullglob && cd "${searchPath}" && ls -1 ${pattern} 2>/dev/null | head -200`,
        {
          encoding: 'utf-8',
          timeout: 10_000,
          shell: '/bin/bash',
        },
      );
      return output.trim() || 'No matches found';
    } catch {
      return 'No matches found';
    }
  }
}

function executeGrep(args: Record<string, unknown>): string {
  const pattern = args.pattern as string;
  const searchPath = (args.path as string) || '/workspace/group';
  const fileGlob = args.glob as string | undefined;
  if (!pattern) return 'Error: pattern is required';

  const grepArgs = ['grep', '-rn', '--color=never'];
  if (fileGlob) {
    grepArgs.push('--include', fileGlob);
  }
  grepArgs.push(pattern, searchPath);

  try {
    const output = execSync(grepArgs.join(' '), {
      encoding: 'utf-8',
      timeout: 10_000,
      maxBuffer: MAX_OUTPUT_SIZE,
    });
    return output.trim() || 'No matches found';
  } catch {
    return 'No matches found';
  }
}

async function executeWebSearch(
  args: Record<string, unknown>,
): Promise<string> {
  const query = args.query as string;
  if (!query) return 'Error: query is required';

  try {
    // Use DuckDuckGo instant answer API (JSON, no CAPTCHA)
    const encoded = encodeURIComponent(query);
    const response = await fetch(
      `https://api.duckduckgo.com/?q=${encoded}&format=json&no_html=1&skip_disambig=1`,
    );
    if (!response.ok) throw new Error(`status ${response.status}`);

    const data = (await response.json()) as {
      AbstractText?: string;
      AbstractURL?: string;
      AbstractSource?: string;
      RelatedTopics?: Array<{
        Text?: string;
        FirstURL?: string;
        Topics?: Array<{ Text?: string; FirstURL?: string }>;
      }>;
    };

    const results: string[] = [];

    // Main abstract
    if (data.AbstractText) {
      results.push(`${data.AbstractSource || 'Summary'}: ${data.AbstractText}`);
      if (data.AbstractURL) results.push(`Source: ${data.AbstractURL}`);
      results.push('');
    }

    // Related topics
    if (data.RelatedTopics) {
      for (const topic of data.RelatedTopics.slice(0, 8)) {
        if (topic.Text && topic.FirstURL) {
          results.push(`• ${topic.Text}`);
          results.push(`  ${topic.FirstURL}`);
        }
        // Nested topics
        if (topic.Topics) {
          for (const sub of topic.Topics.slice(0, 3)) {
            if (sub.Text && sub.FirstURL) {
              results.push(`• ${sub.Text}`);
              results.push(`  ${sub.FirstURL}`);
            }
          }
        }
      }
    }

    if (results.length > 0) return results.join('\n');

    // Fallback: fetch a search results page and extract text
    const fetchResult = await executeWebFetch({
      url: `https://search.brave.com/search?q=${encoded}`,
    });
    return fetchResult || 'No results found';
  } catch (err) {
    // Fallback to Brave Search as plain text
    try {
      const encoded = encodeURIComponent(query);
      return await executeWebFetch({
        url: `https://search.brave.com/search?q=${encoded}`,
      });
    } catch {
      return `Search error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

async function executeWebFetch(args: Record<string, unknown>): Promise<string> {
  const url = args.url as string;
  if (!url) return 'Error: url is required';

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return 'Error: url must start with http:// or https://';
  }

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; NanoClaw/1.0; +https://github.com/qwibitai/nanoclaw)',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return `Fetch error: HTTP ${response.status}`;

    let html = await response.text();
    if (html.length > 2 * 1024 * 1024) {
      html = html.slice(0, 2 * 1024 * 1024);
    }

    // Strip script, style, nav, header, footer tags and their contents
    let text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<svg[\s\S]*?<\/svg>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '');

    // Strip remaining HTML tags
    text = text.replace(/<[^>]+>/g, ' ');

    // Decode HTML entities
    text = text
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'");

    // Collapse whitespace and trim lines
    text = text
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter((line) => line.length > 0)
      .join('\n');

    // Limit output
    const lines = text.split('\n').slice(0, 200);
    return lines.join('\n') || '(empty page)';
  } catch (err) {
    return `Fetch error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
