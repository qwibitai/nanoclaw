/**
 * Browser MCP Server for NanoClaw
 * Provides Playwright-based browser automation tools
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { chromium, Browser, BrowserContext, Page } from 'playwright';

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;

async function ensureBrowser(): Promise<Page> {
  if (!browser) {
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
    browser = await chromium.launch({
      headless: true,
      executablePath
    });
    context = await browser.newContext();
    page = await context.newPage();
  }
  return page!;
}

export function createBrowserMcp() {
  return createSdkMcpServer({
    name: 'browser',
    version: '1.0.0',
    tools: [
      tool(
        'navigate',
        'Navigate to a URL in the browser',
        {
          url: z.string().describe('URL to navigate to')
        },
        async (args) => {
          const p = await ensureBrowser();
          await p.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
          return {
            content: [{
              type: 'text',
              text: `Navigated to ${args.url}`
            }]
          };
        }
      ),

      tool(
        'screenshot',
        'Take a screenshot of the current page',
        {
          path: z.string().describe('Path to save screenshot (e.g., /workspace/group/screenshot.png)'),
          fullPage: z.boolean().optional().describe('Capture full page instead of viewport')
        },
        async (args) => {
          const p = await ensureBrowser();
          await p.screenshot({
            path: args.path,
            fullPage: args.fullPage || false
          });
          return {
            content: [{
              type: 'text',
              text: `Screenshot saved to ${args.path}`
            }]
          };
        }
      ),

      tool(
        'click',
        'Click an element on the page',
        {
          selector: z.string().describe('CSS selector for element to click')
        },
        async (args) => {
          const p = await ensureBrowser();
          await p.click(args.selector);
          return {
            content: [{
              type: 'text',
              text: `Clicked ${args.selector}`
            }]
          };
        }
      ),

      tool(
        'fill',
        'Fill a form field with text',
        {
          selector: z.string().describe('CSS selector for input field'),
          value: z.string().describe('Text to fill')
        },
        async (args) => {
          const p = await ensureBrowser();
          await p.fill(args.selector, args.value);
          return {
            content: [{
              type: 'text',
              text: `Filled ${args.selector} with "${args.value}"`
            }]
          };
        }
      ),

      tool(
        'get_content',
        'Get the text content or HTML of the current page',
        {
          format: z.enum(['text', 'html']).optional().describe('Content format (default: text)')
        },
        async (args) => {
          const p = await ensureBrowser();
          const content = args.format === 'html'
            ? await p.content()
            : await p.innerText('body');

          // Truncate if too long
          const truncated = content.length > 50000
            ? content.slice(0, 50000) + '\n... (truncated)'
            : content;

          return {
            content: [{
              type: 'text',
              text: truncated
            }]
          };
        }
      ),

      tool(
        'close',
        'Close the browser',
        {},
        async () => {
          if (browser) {
            await browser.close();
            browser = null;
            context = null;
            page = null;
          }
          return {
            content: [{
              type: 'text',
              text: 'Browser closed'
            }]
          };
        }
      )
    ]
  });
}
