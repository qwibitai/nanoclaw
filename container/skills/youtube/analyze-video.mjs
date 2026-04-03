#!/usr/bin/env node

/**
 * Analyze a video file with Gemini 1.5 Flash.
 * Usage: node analyze-video.mjs <filepath> [caption]
 *
 * Reads GEMINI_API_KEY from environment.
 * Prints analysis to stdout, fallback message on error.
 * Never exits with non-zero code.
 */

import { readFileSync, statSync } from 'fs';
import { basename, extname } from 'path';

const GEMINI_MAX_VIDEO_MB = 20;
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const filepath = process.argv[2];
const caption = process.argv[3] || '';

if (!filepath) {
  console.log('Usage: node analyze-video.mjs <filepath> [caption]');
  process.exit(0);
}

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.log('[Video analysis skipped — GEMINI_API_KEY not set]');
  process.exit(0);
}

try {
  const stats = statSync(filepath);
  const sizeMB = stats.size / (1024 * 1024);

  if (sizeMB > GEMINI_MAX_VIDEO_MB) {
    console.log(
      `[Video too large for inline analysis (${sizeMB.toFixed(1)}MB > ${GEMINI_MAX_VIDEO_MB}MB limit)]`,
    );
    process.exit(0);
  }

  const buffer = readFileSync(filepath);
  const base64 = buffer.toString('base64');

  const ext = extname(filepath).toLowerCase();
  const mimeMap = {
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska',
  };
  const mimeType = mimeMap[ext] || 'video/mp4';

  const prompt = caption
    ? `Describe this video in detail. The sender included this caption: "${caption}"`
    : 'Describe this video in detail.';

  const url = `${API_BASE}/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: prompt },
            {
              inline_data: {
                mime_type: mimeType,
                data: base64,
              },
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    console.log(`[Video analysis failed — API error: ${response.status}]`);
    process.exit(0);
  }

  const result = await response.json();
  const text =
    result?.candidates?.[0]?.content?.parts?.[0]?.text || '[No analysis generated]';
  console.log(text);
} catch (err) {
  console.log(`[Video analysis failed — ${err.message || err}]`);
  process.exit(0);
}
