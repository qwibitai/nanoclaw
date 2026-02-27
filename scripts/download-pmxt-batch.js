#!/usr/bin/env node

/**
 * Batch download pmxt.dev Polymarket historical data
 *
 * Usage:
 *   node scripts/download-pmxt-batch.js --start 2026-02-01 --end 2026-02-27 --output ./data/pmxt
 *   node scripts/download-pmxt-batch.js --date 2026-02-27 --output ./data/pmxt  # Single day
 *   node scripts/download-pmxt-batch.js --latest 7 --output ./data/pmxt  # Last 7 days
 */

import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';

const PMXT_BASE = 'https://archive.pmxt.dev/dumps/';

// Parse command line args
const args = process.argv.slice(2);
const getArg = (flag) => {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : null;
};

const startDate = getArg('--start');
const endDate = getArg('--end');
const singleDate = getArg('--date');
const latest = getArg('--latest');
const outputDir = getArg('--output') || './data/pmxt';
const resume = args.includes('--resume'); // Resume interrupted downloads
const parallel = parseInt(getArg('--parallel') || '3', 10); // Concurrent downloads

// Generate date range
function generateDateRange(start, end) {
  const dates = [];
  const current = new Date(start);
  const endDate = new Date(end);

  while (current <= endDate) {
    dates.push(current.toISOString().split('T')[0]);
    current.setDate(current.getDate() + 1);
  }

  return dates;
}

// Generate list of files to download
function generateFileList() {
  let dates = [];

  if (singleDate) {
    dates = [singleDate];
  } else if (latest) {
    const now = new Date();
    for (let i = parseInt(latest) - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().split('T')[0]);
    }
  } else if (startDate && endDate) {
    dates = generateDateRange(startDate, endDate);
  } else {
    console.error('Usage: --start YYYY-MM-DD --end YYYY-MM-DD  OR  --date YYYY-MM-DD  OR  --latest N');
    process.exit(1);
  }

  const files = [];
  for (const date of dates) {
    for (let hour = 0; hour < 24; hour++) {
      const hourStr = hour.toString().padStart(2, '0');
      const filename = `polymarket_orderbook_${date}T${hourStr}.parquet`;
      files.push({
        url: `${PMXT_BASE}${filename}`,
        filename,
        localPath: path.join(outputDir, filename),
      });
    }
  }

  return files;
}

// Download a single file with retry
async function downloadFile(file, retries = 3) {
  const { url, localPath } = file;

  // Skip if already exists and resume mode
  if (resume && fs.existsSync(localPath)) {
    const stats = fs.statSync(localPath);
    // Skip if file is > 100MB (likely complete)
    if (stats.size > 100 * 1024 * 1024) {
      console.log(`⏭️  Skipping (exists): ${file.filename}`);
      return { success: true, skipped: true };
    }
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`📥 Downloading (attempt ${attempt}/${retries}): ${file.filename}`);

      const response = await fetch(url);

      if (!response.ok) {
        if (response.status === 404) {
          console.log(`❌ Not found: ${file.filename}`);
          return { success: false, notFound: true };
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // Ensure directory exists
      fs.mkdirSync(path.dirname(localPath), { recursive: true });

      // Stream to file
      await pipeline(response.body, createWriteStream(localPath));

      const stats = fs.statSync(localPath);
      const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
      console.log(`✅ Downloaded: ${file.filename} (${sizeMB} MB)`);

      return { success: true, size: stats.size };
    } catch (err) {
      console.error(`❌ Error (attempt ${attempt}/${retries}): ${err.message}`);

      if (attempt === retries) {
        // Delete partial file
        if (fs.existsSync(localPath)) {
          fs.unlinkSync(localPath);
        }
        return { success: false, error: err.message };
      }

      // Wait before retry (exponential backoff)
      await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
    }
  }
}

// Download files in parallel batches
async function downloadBatch(files, concurrency) {
  const results = {
    total: files.length,
    success: 0,
    failed: 0,
    skipped: 0,
    notFound: 0,
    totalSize: 0,
  };

  console.log(`\n📦 Downloading ${files.length} files (${concurrency} parallel)...\n`);

  // Process in batches
  for (let i = 0; i < files.length; i += concurrency) {
    const batch = files.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(f => downloadFile(f)));

    for (const result of batchResults) {
      if (result.success) {
        if (result.skipped) results.skipped++;
        else results.success++;
        results.totalSize += result.size || 0;
      } else if (result.notFound) {
        results.notFound++;
      } else {
        results.failed++;
      }
    }

    // Progress
    const completed = Math.min(i + concurrency, files.length);
    const pct = ((completed / files.length) * 100).toFixed(1);
    console.log(`\n📊 Progress: ${completed}/${files.length} (${pct}%)`);
  }

  return results;
}

// Main
async function main() {
  console.log('=== pmxt.dev Batch Downloader ===\n');

  const files = generateFileList();

  console.log(`Date range: ${files[0].filename.match(/\d{4}-\d{2}-\d{2}/)[0]} to ${files[files.length - 1].filename.match(/\d{4}-\d{2}-\d{2}/)[0]}`);
  console.log(`Total files: ${files.length}`);
  console.log(`Output directory: ${outputDir}`);
  console.log(`Resume mode: ${resume ? 'ON' : 'OFF'}`);
  console.log(`Parallel downloads: ${parallel}\n`);

  const startTime = Date.now();
  const results = await downloadBatch(files, parallel);
  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

  console.log('\n=== DOWNLOAD COMPLETE ===');
  console.log(`✅ Success: ${results.success}`);
  console.log(`⏭️  Skipped: ${results.skipped}`);
  console.log(`❌ Failed: ${results.failed}`);
  console.log(`🔍 Not found: ${results.notFound}`);
  console.log(`📦 Total size: ${(results.totalSize / (1024 * 1024 * 1024)).toFixed(2)} GB`);
  console.log(`⏱️  Time: ${elapsed} minutes`);

  if (results.failed > 0) {
    console.log('\n⚠️  Some files failed to download. Run with --resume to retry.');
  }

  // Save manifest
  const manifest = {
    downloadedAt: new Date().toISOString(),
    dateRange: {
      start: files[0].filename.match(/\d{4}-\d{2}-\d{2}/)[0],
      end: files[files.length - 1].filename.match(/\d{4}-\d{2}-\d{2}/)[0],
    },
    results,
    files: files.map(f => f.filename),
  };

  fs.writeFileSync(
    path.join(outputDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
  );

  console.log(`\n📄 Manifest saved to: ${path.join(outputDir, 'manifest.json')}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
