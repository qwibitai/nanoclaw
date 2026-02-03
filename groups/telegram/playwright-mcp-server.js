#!/usr/bin/env node

/**
 * Playwright MCP Server
 * Provides browser automation tools to Claude Code
 */

const { chromium } = require('playwright');

let browser = null;
let context = null;
let page = null;

const tools = [
  {
    name: 'browser_navigate',
    description: 'Navigate to a URL',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to navigate to' }
      },
      required: ['url']
    }
  },
  {
    name: 'browser_screenshot',
    description: 'Take a screenshot of the current page',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to save screenshot' },
        fullPage: { type: 'boolean', description: 'Capture full page', default: false }
      },
      required: ['path']
    }
  },
  {
    name: 'browser_click',
    description: 'Click an element on the page',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector for element to click' }
      },
      required: ['selector']
    }
  },
  {
    name: 'browser_fill',
    description: 'Fill a form field',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector for input' },
        value: { type: 'string', description: 'Value to fill' }
      },
      required: ['selector', 'value']
    }
  },
  {
    name: 'browser_get_content',
    description: 'Get page content (text or HTML)',
    inputSchema: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['text', 'html'],
          description: 'Content format',
          default: 'text'
        }
      }
    }
  },
  {
    name: 'browser_close',
    description: 'Close the browser',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  }
];

async function ensureBrowser() {
  if (!browser) {
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
    browser = await chromium.launch({
      headless: true,
      executablePath
    });
    context = await browser.newContext();
    page = await context.newPage();
  }
}

async function handleToolCall(name, args) {
  await ensureBrowser();

  switch (name) {
    case 'browser_navigate':
      await page.goto(args.url);
      return { content: [{ type: 'text', text: `Navigated to ${args.url}` }] };

    case 'browser_screenshot':
      await page.screenshot({ path: args.path, fullPage: args.fullPage || false });
      return { content: [{ type: 'text', text: `Screenshot saved to ${args.path}` }] };

    case 'browser_click':
      await page.click(args.selector);
      return { content: [{ type: 'text', text: `Clicked ${args.selector}` }] };

    case 'browser_fill':
      await page.fill(args.selector, args.value);
      return { content: [{ type: 'text', text: `Filled ${args.selector}` }] };

    case 'browser_get_content':
      const content = args.format === 'html'
        ? await page.content()
        : await page.innerText('body');
      return { content: [{ type: 'text', text: content }] };

    case 'browser_close':
      if (browser) {
        await browser.close();
        browser = null;
        context = null;
        page = null;
      }
      return { content: [{ type: 'text', text: 'Browser closed' }] };

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// MCP Protocol Handler
async function handleMessage(message) {
  const { method, params } = message;

  switch (method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'playwright-browser', version: '1.0.0' }
      };

    case 'tools/list':
      return { tools };

    case 'tools/call':
      return await handleToolCall(params.name, params.arguments || {});

    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

// STDIO transport for MCP
process.stdin.setEncoding('utf8');
let buffer = '';

process.stdin.on('data', async (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop();

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const message = JSON.parse(line);
      const result = await handleMessage(message);
      console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    } catch (error) {
      console.log(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id || null,
        error: { code: -32603, message: error.message }
      }));
    }
  }
});

process.on('SIGINT', async () => {
  if (browser) await browser.close();
  process.exit(0);
});
