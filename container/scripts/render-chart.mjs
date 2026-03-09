#!/usr/bin/env node
/**
 * Render an Apache ECharts configuration to a PNG image using Puppeteer + Chromium.
 *
 * Usage:
 *   node render-chart.mjs --input /tmp/chart.json --output /tmp/chart.png [--width 800] [--height 600]
 *
 * The input JSON must be a valid ECharts option object.
 */
import fs from 'fs';
import { createRequire } from 'module';
import { parseArgs } from 'util';

// Resolve globally-installed packages
const require = createRequire('/usr/local/lib/node_modules/');
const puppeteer = require('puppeteer-core');

const { values: args } = parseArgs({
  options: {
    input:      { type: 'string', short: 'i' },
    output:     { type: 'string', short: 'o', default: '/tmp/chart.png' },
    width:      { type: 'string', short: 'w', default: '800' },
    height:     { type: 'string', short: 'h', default: '600' },
    background: { type: 'string', short: 'b', default: 'white' },
  },
});

if (!args.input) {
  console.error('Usage: render-chart.mjs --input <json-file> --output <png-file> [--width 800] [--height 600]');
  process.exit(1);
}

const chartOption = JSON.parse(fs.readFileSync(args.input, 'utf-8'));
const width = parseInt(args.width, 10);
const height = parseInt(args.height, 10);

// Find the globally installed echarts bundle
const echartsPath = '/usr/local/lib/node_modules/echarts/dist/echarts.min.js';
if (!fs.existsSync(echartsPath)) {
  console.error('ECharts not found at', echartsPath);
  process.exit(1);
}

const browser = await puppeteer.launch({
  executablePath: process.env.AGENT_BROWSER_EXECUTABLE_PATH || '/usr/bin/chromium',
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width, height });

  // Build a minimal HTML page
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:${args.background};">
  <div id="chart" style="width:${width}px;height:${height}px;"></div>
</body></html>`;

  await page.setContent(html, { waitUntil: 'domcontentloaded' });

  // Inject ECharts library
  await page.addScriptTag({ path: echartsPath });

  // Render the chart
  await page.evaluate((option) => {
    const chart = echarts.init(document.getElementById('chart'));
    chart.setOption(option);
  }, chartOption);

  // Wait for any animations to settle
  await new Promise(r => setTimeout(r, 300));

  // Screenshot the chart div
  const chartEl = await page.$('#chart');
  await chartEl.screenshot({ path: args.output, type: 'png' });

  console.log(args.output);
} finally {
  await browser.close();
}
