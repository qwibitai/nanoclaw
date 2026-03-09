/**
 * Host-side chart renderer using Puppeteer + Chrome.
 * Renders Apache ECharts options to PNG buffers.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import puppeteer, { Browser } from 'puppeteer-core';

import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Find Chrome on macOS
const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome-stable',
];

function findChrome(): string | null {
  for (const p of CHROME_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ECharts CDN fallback + local bundle
const ECHARTS_CDN =
  'https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js';

let cachedBrowser: Browser | null = null;
let browserLastUsed = 0;
const BROWSER_IDLE_TIMEOUT = 60000; // Close browser after 60s idle

async function getBrowser(): Promise<Browser> {
  if (cachedBrowser?.connected) {
    browserLastUsed = Date.now();
    return cachedBrowser;
  }

  const chromePath = findChrome();
  if (!chromePath) {
    throw new Error('Chrome/Chromium not found on host');
  }

  cachedBrowser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  browserLastUsed = Date.now();

  // Auto-close after idle
  const checkIdle = setInterval(async () => {
    if (Date.now() - browserLastUsed > BROWSER_IDLE_TIMEOUT && cachedBrowser) {
      try {
        await cachedBrowser.close();
      } catch {}
      cachedBrowser = null;
      clearInterval(checkIdle);
    }
  }, 10000);

  return cachedBrowser;
}

export interface ChartRenderOptions {
  chartOption: string; // JSON string of ECharts option
  width?: number;
  height?: number;
  background?: string;
}

export async function renderChart(opts: ChartRenderOptions): Promise<Buffer> {
  const { chartOption, width = 800, height = 600, background = 'white' } = opts;

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width, height });

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<script src="${ECHARTS_CDN}"></script>
</head>
<body style="margin:0;padding:0;background:${background};">
  <div id="chart" style="width:${width}px;height:${height}px;"></div>
</body></html>`;

    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 });

    // Parse and render the chart
    const chartOpt = JSON.parse(chartOption);
    await page.evaluate((option) => {
      /* eslint-disable no-undef */
      const echarts = (globalThis as any).echarts;
      const el = (globalThis as any).document.getElementById('chart');
      const chart = echarts.init(el);
      chart.setOption(option);
    }, chartOpt);

    // Wait for animations
    await new Promise((r) => setTimeout(r, 300));

    const chartEl = await page.$('#chart');
    if (!chartEl) throw new Error('Chart element not found');

    const screenshot = await chartEl.screenshot({ type: 'png' });
    return Buffer.from(screenshot);
  } finally {
    await page.close();
  }
}
