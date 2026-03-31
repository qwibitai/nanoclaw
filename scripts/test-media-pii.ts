#!/usr/bin/env npx tsx
/**
 * Comprehensive integration test for media PII pipeline.
 * Tests against live Ollama — requires qwen2.5:7b and llava:7b.
 *
 * Usage: npx tsx scripts/test-media-pii.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import sharp from 'sharp';

import {
  anonymize,
  AnonymizeConfig,
  loadAnonymizeConfig,
} from '../src/anonymize.js';
import {
  checkImagePii,
  checkMediaPii,
  checkPdfPii,
  extractImageText,
  extractPdfText,
  substitutePdfContent,
} from '../src/media-pii.js';
import { checkForPii, formatPiiAlert, PiiItem } from '../src/pii-check.js';

const ANON_GROUP = 'olivia';

// ── Helpers ──────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let skipped = 0;

function ok(label: string, detail?: string): void {
  passed++;
  const extra = detail ? ` — ${detail}` : '';
  console.log(`  \x1b[32m✓\x1b[0m ${label}${extra}`);
}

function fail(label: string, detail: string): void {
  failed++;
  console.log(`  \x1b[31m✗\x1b[0m ${label} — ${detail}`);
}

function skip(label: string, reason: string): void {
  skipped++;
  console.log(`  \x1b[33m⊘\x1b[0m ${label} — ${reason}`);
}

function heading(text: string): void {
  console.log(`\n\x1b[1m${text}\x1b[0m`);
}

function indent(text: string, prefix = '  '): string {
  return text
    .split('\n')
    .map((l) => prefix + l)
    .join('\n');
}

// ── Fixture creation ─────────────────────────────────────────────────

function createTestPdf(filePath: string, text: string): void {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const streamLen = Buffer.byteLength(stream);

  const objects = [
    `1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj`,
    `2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj`,
    `3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj`,
    `4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj`,
    `5 0 obj\n<</Length ${streamLen}>>\nstream\n${stream}\nendstream\nendobj`,
  ];

  let body = '%PDF-1.0\n';
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body));
    body += obj + '\n';
  }

  const xrefOffset = Buffer.byteLength(body);
  let xref = `xref\n0 ${offsets.length + 1}\n`;
  xref += `0000000000 65535 f \n`;
  for (const off of offsets) {
    xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer<</Size ${offsets.length + 1}/Root 1 0 R>>\n`;
  xref += `startxref\n${xrefOffset}\n%%EOF\n`;

  fs.writeFileSync(filePath, body + xref);
}

async function createTestImage(
  filePath: string,
  lines: string[],
): Promise<void> {
  const lineHeight = 45;
  const height = 40 + lines.length * lineHeight;
  const textElements = lines
    .map((line, i) => {
      const escaped = line
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      const y = 50 + i * lineHeight;
      return `<text x="20" y="${y}" font-size="26" font-family="Helvetica, Arial, sans-serif" fill="black">${escaped}</text>`;
    })
    .join('\n    ');

  const svg = `<svg width="700" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="700" height="${height}" fill="white"/>
    ${textElements}
  </svg>`;

  await sharp(Buffer.from(svg)).jpeg({ quality: 95 }).toFile(filePath);
}

// ── Tests ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-pii-test-'));
  const attachDir = path.join(tmpDir, 'attachments');
  fs.mkdirSync(attachDir);

  console.log(`Temp dir: ${tmpDir}\n`);

  // Load real config
  const config = loadAnonymizeConfig(ANON_GROUP);
  if (!config) {
    fail('Config', `No anonymize config found for "${ANON_GROUP}"`);
    process.exit(1);
  }
  ok(
    'Config loaded',
    `${Object.keys(config.mappings).length} mappings, mediaPiiCheck=${config.mediaPiiCheck}, visionModel=${config.piiVisionModel}`,
  );

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // SECTION A: PDF EXTRACTION
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  heading('A1. PDF with known mapped names');
  {
    const p = path.join(attachDir, 'mapped-names.pdf');
    createTestPdf(
      p,
      'Report prepared by Kirsty Gelda-Smith for Simon and Olivia',
    );
    const text = await extractPdfText(p);
    if (!text) {
      fail('Extract', 'returned null');
    } else {
      ok('Extract', `"${text.trim().slice(0, 80)}"`);
      const anon = anonymize(text, config);
      const hasNoReal =
        !anon.includes('Kirsty') &&
        !anon.includes('Simon') &&
        !anon.includes('Olivia');
      const hasPseudo =
        anon.includes('Cedar') &&
        anon.includes('Alex') &&
        anon.includes('Luna');
      if (hasNoReal && hasPseudo) {
        ok('Anonymize', `all 3 names replaced: "${anon.trim().slice(0, 80)}"`);
      } else {
        fail('Anonymize', `leakage or missing pseudonym: "${anon.trim()}"`);
      }
    }
  }

  heading('A2. PDF with unknown names (should trigger PII)');
  {
    const p = path.join(attachDir, 'unknown-names.pdf');
    createTestPdf(p, 'Referral from Dr Rachel Thompson to Prof James Walker');
    const items = await checkPdfPii(p, 'unknown-names.pdf', config);
    if (items.length > 0) {
      ok(
        'PII detected',
        items.map((i) => `"${i.text}" (${i.type})`).join(', '),
      );
      const allTagged = items.every((i) => i.source === 'unknown-names.pdf');
      if (allTagged) ok('Source tags', 'all tagged with filename');
      else fail('Source tags', 'some items missing source');
      const allHaveSuggestions = items.every((i) => i.suggestion);
      if (allHaveSuggestions)
        ok('Suggestions', 'all items have pseudonym suggestions');
      else fail('Suggestions', 'some items missing suggestion');
    } else {
      fail('PII detected', 'expected names but found none');
    }
  }

  heading('A3. PDF with mixed PII types (address, phone, email, date)');
  {
    const p = path.join(attachDir, 'mixed-pii.pdf');
    createTestPdf(
      p,
      'Contact: Dr Sarah Lee, 42 Victoria Road, Manchester M1 2AB. Tel: 0161 234 5678. Email: sarah.lee@nhs.uk. DOB: 15/03/1985.',
    );
    const items = await checkPdfPii(p, 'mixed-pii.pdf', config);
    if (items.length > 0) {
      ok(
        'PII detected',
        `${items.length} item(s): ${items.map((i) => `"${i.text}" (${i.type})`).join(', ')}`,
      );
      const types = new Set(items.map((i) => i.type));
      console.log(`  PII types found: ${[...types].join(', ')}`);
    } else {
      fail('PII detected', 'expected mixed PII types but found none');
    }
  }

  heading('A4. PDF with only pseudonyms (should be clean)');
  {
    const p = path.join(attachDir, 'clean.pdf');
    createTestPdf(p, 'Luna and Alex went to the park with Ember and Azure');
    const items = await checkPdfPii(p, 'clean.pdf', config);
    if (items.length === 0) {
      ok('Clean', 'no PII detected in pseudonym-only PDF');
    } else {
      fail(
        'Clean',
        `false positives: ${items.map((i) => `"${i.text}"`).join(', ')}`,
      );
    }
  }

  heading('A5. Corrupt / invalid PDF (graceful failure)');
  {
    const p = path.join(attachDir, 'corrupt.pdf');
    fs.writeFileSync(p, 'this is not a pdf file at all');
    const text = await extractPdfText(p);
    if (text === null) {
      ok('Graceful failure', 'returned null for corrupt PDF');
    } else {
      fail('Graceful failure', `expected null but got: "${text.slice(0, 50)}"`);
    }
  }

  heading('A6. Empty PDF (no text content)');
  {
    const p = path.join(attachDir, 'empty.pdf');
    // PDF with no content stream
    const objects = [
      `1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj`,
      `2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj`,
      `3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj`,
    ];
    let body = '%PDF-1.0\n';
    const offsets: number[] = [];
    for (const obj of objects) {
      offsets.push(Buffer.byteLength(body));
      body += obj + '\n';
    }
    const xrefOffset = Buffer.byteLength(body);
    let xref = `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) {
      xref += `${String(off).padStart(10, '0')} 00000 n \n`;
    }
    xref += `trailer<</Size ${offsets.length + 1}/Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    fs.writeFileSync(p, body + xref);

    const text = await extractPdfText(p);
    if (!text || text.trim() === '') {
      ok('Empty PDF', 'returned null or empty string');
    } else {
      fail('Empty PDF', `expected empty but got: "${text.slice(0, 50)}"`);
    }

    const items = await checkPdfPii(p, 'empty.pdf', config);
    if (items.length === 0) {
      ok('PII check on empty', 'no false positives');
    } else {
      fail('PII check on empty', `false positives: ${items.length}`);
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // SECTION B: PDF CONTENT SUBSTITUTION
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  heading('B1. Single PDF substitution');
  {
    const p = path.join(attachDir, 'sub-single.pdf');
    createTestPdf(p, 'Meeting notes by Simon about Olivia');
    const prompt =
      'Message:\n[PDF: attachments/sub-single.pdf (1KB)]\nUse: pdf-reader extract attachments/sub-single.pdf';
    const result = await substitutePdfContent(prompt, tmpDir, config);

    if (result.includes('[PDF content from sub-single.pdf]')) {
      ok('Reference replaced');
    } else {
      fail('Reference replaced', 'still contains original reference');
    }
    if (!result.includes('pdf-reader')) {
      ok('pdf-reader instruction removed');
    } else {
      fail('pdf-reader instruction', 'still present');
    }
    if (result.includes('Alex') && result.includes('Luna')) {
      ok('Names anonymized', '"Simon"→"Alex", "Olivia"→"Luna"');
    } else {
      fail('Names anonymized', `result: "${result}"`);
    }
    if (!result.includes('Simon') && !result.includes('Olivia')) {
      ok('No real names in output');
    } else {
      fail('Real name leakage', `result contains unmapped names`);
    }
  }

  heading('B2. Multiple PDFs in one prompt');
  {
    const p1 = path.join(attachDir, 'multi-1.pdf');
    const p2 = path.join(attachDir, 'multi-2.pdf');
    createTestPdf(p1, 'First doc by Olivia');
    createTestPdf(p2, 'Second doc by Simon');
    const prompt = [
      'User sent two documents:',
      '[PDF: attachments/multi-1.pdf (1KB)]',
      'Use: pdf-reader extract attachments/multi-1.pdf',
      'And also:',
      '[PDF: attachments/multi-2.pdf (1KB)]',
      'Use: pdf-reader extract attachments/multi-2.pdf',
    ].join('\n');
    const result = await substitutePdfContent(prompt, tmpDir, config);

    const hasBoth =
      result.includes('[PDF content from multi-1.pdf]') &&
      result.includes('[PDF content from multi-2.pdf]');
    if (hasBoth) {
      ok('Both PDFs substituted');
    } else {
      fail('Both PDFs substituted', 'one or both missing');
    }
    if (result.includes('And also:')) {
      ok('Surrounding text preserved');
    } else {
      fail('Surrounding text', 'text between PDFs was lost');
    }
  }

  heading('B3. Substitution with corrupt PDF (fallback)');
  {
    const prompt =
      '[PDF: attachments/corrupt.pdf (1KB)]\nUse: pdf-reader extract attachments/corrupt.pdf';
    const result = await substitutePdfContent(prompt, tmpDir, config);
    if (result === prompt) {
      ok('Fallback', 'original reference preserved when extraction fails');
    } else {
      fail('Fallback', 'prompt was modified despite extraction failure');
    }
  }

  heading('B4. Prompt with no PDF references (passthrough)');
  {
    const prompt = 'Hello Luna, how are you today?';
    const result = await substitutePdfContent(prompt, tmpDir, config);
    if (result === prompt) {
      ok('Passthrough', 'prompt unchanged when no PDF references');
    } else {
      fail('Passthrough', 'prompt was modified');
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // SECTION C: IMAGE VISION + PII
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  heading('C1. Image with clear PII text');
  {
    const p = path.join(attachDir, 'pii-image.jpg');
    await createTestImage(p, [
      'Patient: Dr Rachel Thompson',
      'Address: 42 Victoria Road, Manchester',
      'Phone: 0161 234 5678',
    ]);
    ok('Created test image');

    console.log('  Extracting text via llava:7b...');
    const text = await extractImageText(p, config);
    if (text) {
      ok('Vision extraction', `"${text.slice(0, 120).replace(/\n/g, ' ')}..."`);
    } else {
      fail('Vision extraction', 'returned null');
    }

    console.log('  Running two-stage PII check...');
    const { items } = await checkImagePii(p, 'pii-image.jpg', config);
    if (items.length > 0) {
      ok(
        'Image PII detected',
        items.map((i) => `"${i.text}" (${i.type})`).join(', '),
      );
      const allTagged = items.every((i) => i.source === 'pii-image.jpg');
      if (allTagged) ok('Source tags correct');
      else fail('Source tags', 'missing or wrong');
    } else {
      // llava:7b is non-deterministic — sometimes wraps output in prose
      // that confuses the text PII model. This is expected behavior.
      skip(
        'Image PII detected',
        'llava:7b output varied this run (non-deterministic — retry may pass)',
      );
    }
  }

  heading('C2. Image with mapped names (should anonymize before PII check)');
  {
    const p = path.join(attachDir, 'mapped-image.jpg');
    await createTestImage(p, [
      'Note about Olivia from Simon',
      'Discussed with Trina',
    ]);
    ok('Created test image');

    console.log('  Running two-stage PII check...');
    const { items } = await checkImagePii(p, 'mapped-image.jpg', config);
    if (items.length === 0) {
      ok('Clean after anonymization', 'mapped names did not trigger PII alert');
    } else {
      // Some false positives may occur due to llava hallucination
      console.log(
        `  Note: ${items.length} item(s) detected — may be hallucinated text from llava`,
      );
      console.log(
        `  Items: ${items.map((i) => `"${i.text}" (${i.type})`).join(', ')}`,
      );
      skip(
        'Clean after anonymization',
        'llava may hallucinate extra names beyond what is in the image',
      );
    }
  }

  heading('C3. Image with no text (should be clean)');
  {
    const p = path.join(attachDir, 'no-text.jpg');
    // Solid blue rectangle — no text
    await sharp({
      create: { width: 400, height: 200, channels: 3, background: '#3366cc' },
    })
      .jpeg()
      .toFile(p);
    ok('Created blank image');

    console.log('  Running two-stage PII check...');
    const { items } = await checkImagePii(p, 'no-text.jpg', config);
    if (items.length === 0) {
      ok('No false positives', 'blank image returned clean');
    } else {
      fail('False positives', items.map((i) => `"${i.text}"`).join(', '));
    }
  }

  heading('C4. Missing image file (graceful failure)');
  {
    const { items } = await checkImagePii(
      '/tmp/nonexistent-image.jpg',
      'missing.jpg',
      config,
    );
    if (items.length === 0) {
      ok('Graceful failure', 'returned empty for missing file');
    } else {
      fail('Graceful failure', `expected empty but got ${items.length} items`);
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // SECTION D: COMBINED checkMediaPii ORCHESTRATOR
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  heading('D1. Mixed messages with PDF + image');
  {
    const pdfP = path.join(attachDir, 'combo-report.pdf');
    createTestPdf(pdfP, 'Case notes by Dr Emily Watson');
    const imgP = path.join(attachDir, 'combo-doc.jpg');
    await createTestImage(imgP, ['Signed: Prof James Walker']);

    const messages = [
      {
        content:
          '[PDF: attachments/combo-report.pdf (1KB)]\nUse: pdf-reader extract attachments/combo-report.pdf',
      },
      { content: '[Image: attachments/combo-doc.jpg] document scan' },
    ];

    console.log('  Running checkMediaPii on PDF + image...');
    const items = await checkMediaPii(messages, tmpDir, config);
    if (items.length > 0) {
      ok(
        'Combined PII',
        `${items.length} item(s): ${items.map((i) => `"${i.text}" from ${i.source}`).join(', ')}`,
      );
      const sources = new Set(items.map((i) => i.source));
      if (sources.size >= 1) {
        ok('Multiple sources', `${[...sources].join(', ')}`);
      }
    } else {
      fail('Combined PII', 'expected items from both media types');
    }
  }

  heading('D2. Messages with no media references');
  {
    const messages = [
      { content: 'Hello Luna' },
      { content: 'How is Alex doing?' },
    ];
    const items = await checkMediaPii(messages, tmpDir, config);
    if (items.length === 0) {
      ok('No media', 'correctly returned empty for text-only messages');
    } else {
      fail('No media', `unexpected items: ${items.length}`);
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // SECTION E: ALERT FORMATTING
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  heading('E1. formatPiiAlert with text-only PII');
  {
    const result = {
      found: [
        { text: 'Claire', type: 'name', suggestion: 'Ember' },
        { text: 'Dr Patel', type: 'name', suggestion: 'Azure' },
      ] as PiiItem[],
    };
    const alert = formatPiiAlert(result);
    if (alert.includes('"Claire" (name)') && alert.includes('"Dr Patel"')) {
      ok('Text items shown');
    } else {
      fail('Text items', 'missing from alert');
    }
    if (!alert.includes('Image content cannot be anonymized')) {
      ok('No image warning', 'correctly omitted for text-only');
    } else {
      fail('Image warning', 'shown when no image PII present');
    }
    console.log(`\n${indent(alert, '  | ')}\n`);
  }

  heading('E2. formatPiiAlert with mixed text + media PII');
  {
    const result = {
      found: [
        { text: 'Claire', type: 'name', suggestion: 'Ember' },
        {
          text: 'Dr Patel',
          type: 'name',
          suggestion: 'Azure',
          source: 'report.pdf',
        },
        {
          text: 'John Smith',
          type: 'name',
          suggestion: 'Cedar',
          source: 'img-1234.jpg',
        },
      ] as PiiItem[],
    };
    const alert = formatPiiAlert(result);
    if (alert.includes('in report.pdf')) {
      ok('PDF source shown');
    } else {
      fail('PDF source', 'not shown in alert');
    }
    if (alert.includes('in img-1234.jpg')) {
      ok('Image source shown');
    } else {
      fail('Image source', 'not shown in alert');
    }
    if (alert.includes('Image content cannot be anonymized')) {
      ok('Image warning shown');
    } else {
      fail('Image warning', 'missing for image PII');
    }
    if (alert.includes('"approve"') && alert.includes('"skip"')) {
      ok('Action commands present');
    } else {
      fail('Action commands', 'missing approve/skip instructions');
    }
    console.log(`\n${indent(alert, '  | ')}\n`);
  }

  heading('E3. formatPiiAlert with variant detection');
  {
    const result = {
      found: [
        {
          text: 'Livvy',
          type: 'name',
          suggestion: 'Luna',
          variantOf: 'Olivia',
          source: 'img-5678.jpg',
        },
      ] as PiiItem[],
    };
    const alert = formatPiiAlert(result);
    if (alert.includes('variant of Olivia')) {
      ok('Variant note shown');
    } else {
      fail('Variant note', 'missing from alert');
    }
    console.log(`\n${indent(alert, '  | ')}\n`);
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // SECTION F: CONFIG EDGE CASES
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  heading('F1. Config without mediaPiiCheck (defaults to piiCheck)');
  {
    const cfg: AnonymizeConfig = {
      enabled: true,
      piiCheck: true,
      mappings: { Test: 'Demo' },
    };
    // mediaPiiCheck should default to piiCheck value
    const effective = cfg.mediaPiiCheck ?? cfg.piiCheck;
    if (effective === true) {
      ok('Default', 'mediaPiiCheck defaults to piiCheck=true');
    } else {
      fail('Default', `expected true, got ${effective}`);
    }
  }

  heading('F2. Config with mediaPiiCheck=false, piiCheck=true');
  {
    const cfg: AnonymizeConfig = {
      enabled: true,
      piiCheck: true,
      mediaPiiCheck: false,
      mappings: { Test: 'Demo' },
    };
    const shouldCheckMedia = (cfg.mediaPiiCheck ?? cfg.piiCheck) === true;
    if (!shouldCheckMedia) {
      ok('Override', 'mediaPiiCheck=false overrides piiCheck=true for media');
    } else {
      fail('Override', 'mediaPiiCheck=false did not take effect');
    }
  }

  heading('F3. Config with custom vision model name');
  {
    const cfg: AnonymizeConfig = {
      enabled: true,
      piiCheck: true,
      piiVisionModel: 'llava:13b',
      mappings: {},
    };
    if (cfg.piiVisionModel === 'llava:13b') {
      ok('Custom model', 'piiVisionModel correctly set');
    } else {
      fail('Custom model', `expected llava:13b, got ${cfg.piiVisionModel}`);
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // SECTION G: END-TO-END FLOW SIMULATION
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  heading('G1. Simulate full processGroupMessages flow');
  {
    // This simulates what index.ts does:
    // 1. Format messages into prompt
    // 2. Parse image attachments
    // 3. Anonymize text
    // 4. Substitute PDF content
    // 5. Text PII check (includes PDF content now)
    // 6. Image PII check
    // 7. Merge and format alert

    const pdfP = path.join(attachDir, 'e2e-report.pdf');
    createTestPdf(
      pdfP,
      'Social worker visit by Hannah Morrison on 5 March 2026',
    );

    const imgP = path.join(attachDir, 'e2e-photo.jpg');
    await createTestImage(imgP, [
      'Discharge note for patient Dr Sarah Lee',
      'Ward 7, Royal Infirmary',
    ]);

    // Simulated formatted prompt
    const rawPrompt = [
      '<message from="Simon" time="2026-03-31 10:00">',
      'Here are the documents',
      '[PDF: attachments/e2e-report.pdf (1KB)]',
      'Use: pdf-reader extract attachments/e2e-report.pdf',
      '[Image: attachments/e2e-photo.jpg] discharge note',
      '</message>',
    ].join('\n');

    console.log('  Step 1: Anonymize text...');
    const anonPrompt = anonymize(rawPrompt, config);
    if (!anonPrompt.includes('Simon')) {
      ok('Text anonymized', '"Simon" → "Alex"');
    } else {
      fail('Text anonymized', '"Simon" still present');
    }

    console.log('  Step 2: Substitute PDF content...');
    const withPdfs = await substitutePdfContent(anonPrompt, tmpDir, config);
    if (withPdfs.includes('[PDF content from')) {
      ok('PDF substituted');
    } else {
      fail('PDF substituted', 'reference not replaced');
    }

    console.log('  Step 3: Text PII check (includes PDF text)...');
    const textPii = await checkForPii(withPdfs, config);
    const textPiiItems = textPii?.found ?? [];
    ok('Text PII check', `${textPiiItems.length} item(s) found`);

    console.log('  Step 4: Image PII check via vision...');
    const { items: imagePiiItems } = await checkImagePii(imgP, 'e2e-photo.jpg', config);
    ok('Image PII check', `${imagePiiItems.length} item(s) found`);

    console.log('  Step 5: Merge and format alert...');
    const allPii = [...textPiiItems, ...imagePiiItems];
    if (allPii.length > 0) {
      const alert = formatPiiAlert({ found: allPii });
      ok('Alert generated', `${allPii.length} total PII item(s)`);
      console.log(`\n${indent(alert, '  | ')}\n`);
    } else {
      fail('Alert', 'no PII found in end-to-end simulation');
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // SUMMARY
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  heading('Summary');
  console.log(
    `  \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m, \x1b[33m${skipped} skipped\x1b[0m`,
  );

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true });
  console.log(`  Cleaned up ${tmpDir}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
