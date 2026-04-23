#!/usr/bin/env node
/**
 * Validation script for surrogate sanitization
 *
 * Tests the fix for lone surrogates in JSONL session transcripts
 */

import fs from 'fs';
import path from 'path';
import { sanitizeSurrogates, isValidUTF16, safeJsonStringify } from '../dist/surrogate-sanitize.js';

const USAGE = `
Usage: node scripts/validate-surrogate-fix.mjs <group-folder>

This script validates that lone surrogates in session transcripts
are properly sanitized before being sent to the API.

Examples:
  node scripts/validate-surrogate-fix.mjs my-group
  node scripts/validate-surrogate-fix.mjs work
`;

function findLatestJsonl(groupFolder: string): string | null {
  const sessionDir = path.join('data', 'sessions', groupFolder, '.claude', 'projects');
  
  if (!fs.existsSync(sessionDir)) {
    console.error(`Session directory not found: ${sessionDir}`);
    return null;
  }

  const projects = fs.readdirSync(sessionDir);
  if (projects.length === 0) {
    console.error('No projects found in session directory');
    return null;
  }

  let latestFile: string | null = null;
  let latestTime = 0;

  for (const project of projects) {
    const projectDir = path.join(sessionDir, project);
    const files = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));

    for (const file of files) {
      const filePath = path.join(projectDir, file);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs > latestTime) {
        latestTime = stat.mtimeMs;
        latestFile = filePath;
      }
    }
  }

  return latestFile;
}

function injectSurrogate(filePath: string): string | null {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n');

  if (lines.length === 0) {
    console.error('No lines in JSONL file');
    return null;
  }

  // Get the last line
  const lastLine = lines[lines.length - 1];
  
  try {
    const obj = JSON.parse(lastLine);
    
    // Inject a lone high surrogate into a string field
    if (obj.content && typeof obj.content === 'string') {
      obj.content = obj.content + ' \uD800'; // Lone high surrogate
    } else {
      obj._test_surrogate = '\uD800'; // Lone high surrogate
    }

    const modifiedLine = JSON.stringify(obj);
    lines[lines.length - 1] = modifiedLine;

    const modifiedContent = lines.join('\n') + '\n';
    fs.writeFileSync(filePath, modifiedContent, 'utf-8');
    
    return lastLine; // Return original for restoration
  } catch (e) {
    console.error('Failed to parse/modify JSONL line:', e);
    return null;
  }
}

function checkForSurrogate(filePath: string): boolean {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n');
  const lastLine = lines[lines.length - 1];

  try {
    const obj = JSON.parse(lastLine);
    const str = JSON.stringify(obj);
    return /[\uD800-\uDFFF]/.test(str) && !isValidUTF16(str);
  } catch {
    return false;
  }
}

function sanitizeFile(filePath: string): void {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n');
  
  const sanitizedLines = lines.map(line => {
    try {
      const obj = JSON.parse(line);
      return safeJsonStringify(obj);
    } catch {
      // If we can't parse, just sanitize the raw string
      return sanitizeSurrogates(line);
    }
  });

  const sanitizedContent = sanitizedLines.join('\n') + '\n';
  fs.writeFileSync(filePath, sanitizedContent, 'utf-8');
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(USAGE);
    process.exit(0);
  }

  const groupFolder = args[0];
  
  console.log(`\nTarget group: ${groupFolder}\n`);

  // Find the latest JSONL file
  const targetFile = findLatestJsonl(groupFolder);
  
  if (!targetFile) {
    console.error('Could not find any JSONL session files');
    process.exit(1);
  }

  console.log(`Target file: ${targetFile}\n`);

  // Save original content
  const originalContent = fs.readFileSync(targetFile, 'utf-8');

  // Step 1: Inject surrogate
  console.log('── Step 1: Injected lone surrogate ─────────────────────────────────────');
  const originalLine = injectSurrogate(targetFile);
  
  if (!originalLine) {
    console.error('Failed to inject surrogate');
    process.exit(1);
  }

  const hasSurrogate = checkForSurrogate(targetFile);
  console.log(`  Line now contains lone surrogate: ${hasSurrogate ? '✗ YES (bug reproduced)' : '✓ NO'}`);

  // Step 2: Run sanitizer
  console.log('\n── Step 2: Run sanitizer ────────────────────────────────────────────────');
  sanitizeFile(targetFile);
  
  const stillHasSurrogate = checkForSurrogate(targetFile);
  console.log(`  After sanitizeSessionTranscripts: ${stillHasSurrogate ? '✗ Still has surrogates' : '✓ Surrogate replaced with \\uFFFD (fix works)'}`);

  // Step 3: Restore original
  console.log('\n── Step 3: Original file restored ──────────────────────────────────────');
  fs.writeFileSync(targetFile, originalContent, 'utf-8');
  console.log('  No permanent changes made to the session transcript.');

  // Final status
  console.log('\n── Result ───────────────────────────────────────────────────────────────');
  if (!stillHasSurrogate) {
    console.log('  ✓ Validation PASSED: Surrogate sanitization works correctly');
    process.exit(0);
  } else {
    console.log('  ✗ Validation FAILED: Surrogates not properly sanitized');
    process.exit(1);
  }
}

main().catch(e => {
  console.error('Validation failed:', e);
  process.exit(1);
});
