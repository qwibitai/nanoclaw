import fs from 'fs';
import path from 'path';

import { PDFParse } from 'pdf-parse';

import { anonymize, AnonymizeConfig } from './anonymize.js';
import { parseImageReferences } from './image.js';
import { logger } from './logger.js';
import { checkForPii, OLLAMA_URL, PiiItem } from './pii-check.js';

const DEFAULT_VISION_MODEL = 'llava:7b';
const VISION_TIMEOUT_MS = 60_000;
const MAX_PDF_SIZE = 10 * 1024 * 1024; // 10MB

const PDF_REF_SOURCE = String.raw`\[PDF: (attachments\/[^\s)]+)(?: \(\d+KB\))?\]\n?(?:Use: pdf-reader extract [^\n]+)?`;

/**
 * Extract text from a PDF file using pdf-parse.
 * Returns null on error (password-protected, corrupt, too large).
 */
export async function extractPdfText(pdfPath: string): Promise<string | null> {
  try {
    const stat = fs.statSync(pdfPath);
    if (stat.size > MAX_PDF_SIZE) {
      logger.warn(
        { path: pdfPath, sizeBytes: stat.size },
        'media-pii: PDF too large, skipping extraction',
      );
      return null;
    }

    const buffer = fs.readFileSync(pdfPath);
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const result = await parser.getText();
      // Strip pdf-parse pagination footers like "-- 1 of 3 --"
      const cleaned = (result.text || '')
        .replace(/--\s*\d+\s*of\s*\d+\s*--/g, '')
        .trim();
      return cleaned || null;
    } finally {
      await parser.destroy();
    }
  } catch (err) {
    logger.warn(
      { err, path: pdfPath },
      'media-pii: failed to extract PDF text',
    );
    return null;
  }
}

/**
 * Check a PDF for PII by extracting text, anonymizing, and running
 * through the Ollama PII checker.
 */
export async function checkPdfPii(
  pdfPath: string,
  filename: string,
  config: AnonymizeConfig,
): Promise<PiiItem[]> {
  const text = await extractPdfText(pdfPath);
  if (!text) return [];

  const anonymized = anonymize(text, config);
  const result = await checkForPii(anonymized, config);
  if (!result) return [];

  return result.found.map((item) => ({ ...item, source: filename }));
}

export interface MediaCheckFailure {
  filename: string;
  reason: string;
}

/**
 * Extract text from an image using an Ollama vision model.
 * Returns the raw text the model reads, or null if the model sees no text.
 * Throws on Ollama errors (connection refused, timeout, model not found)
 * so callers can distinguish "clean image" from "couldn't check".
 */
export async function extractImageText(
  imagePath: string,
  config: AnonymizeConfig,
): Promise<string | null> {
  const model = config.piiVisionModel || DEFAULT_VISION_MODEL;

  let imageData: string;
  try {
    const buffer = fs.readFileSync(imagePath);
    imageData = buffer.toString('base64');
  } catch (err) {
    logger.warn({ err, path: imagePath }, 'media-pii: failed to read image');
    // File not readable is not an Ollama failure — image simply doesn't exist
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);

  try {
    const resp = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt:
          'Read all text visible in this image. Output ONLY the text you see, nothing else. Include all names, dates, addresses, and reference numbers exactly as written.',
        images: [imageData],
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      throw new Error(`Ollama returned status ${resp.status}`);
    }

    const body = (await resp.json()) as { response?: string };
    return body.response?.trim() || null;
  } finally {
    clearTimeout(timer);
  }
}

export interface ImagePiiResult {
  items: PiiItem[];
  /** Set when the check could not run — image should be stripped. */
  failure?: MediaCheckFailure;
}

/**
 * Check an image for PII using a two-stage pipeline:
 * 1. Vision model (llava) extracts text from the image
 * 2. Text model (qwen2.5) scans extracted text for PII
 *
 * Returns a failure if the check could not run (Ollama down, model not
 * pulled, etc.) — the caller must strip the image rather than letting
 * it through unchecked.
 */
export async function checkImagePii(
  imagePath: string,
  filename: string,
  config: AnonymizeConfig,
): Promise<ImagePiiResult> {
  // Stage 1: Extract text from image via vision model
  let imageText: string | null;
  try {
    imageText = await extractImageText(imagePath, config);
  } catch {
    return {
      items: [],
      failure: { filename, reason: 'vision model unreachable' },
    };
  }

  // null means vision model ran but found no readable text — that's clean
  if (imageText === null) return { items: [] };

  logger.debug(
    { filename, textLength: imageText.length },
    'media-pii: extracted text from image',
  );

  // Stage 2: Anonymize and check extracted text via text PII model
  const anonymized = anonymize(imageText, config);
  const result = await checkForPii(anonymized, config);
  if (!result) return { items: [] };

  return {
    items: result.found.map((item) => ({ ...item, source: filename })),
  };
}

/**
 * Orchestrate PII checks across all PDFs and images in a set of messages.
 * Runs PDF checks first (reuses text model), then image checks (loads vision model).
 */
export async function checkMediaPii(
  messages: Array<{ content: string }>,
  groupDir: string,
  config: AnonymizeConfig,
): Promise<PiiItem[]> {
  const allItems: PiiItem[] = [];

  // Collect PDF references
  for (const ref of collectPdfRefs(messages.map((m) => m.content).join('\n'))) {
    const fullPath = path.join(groupDir, ref.relativePath);
    const items = await checkPdfPii(fullPath, ref.filename, config);
    allItems.push(...items);
  }

  // Check images (sequential to avoid Ollama memory pressure)
  for (const img of parseImageReferences(messages)) {
    const fullPath = path.join(groupDir, img.relativePath);
    const result = await checkImagePii(
      fullPath,
      path.basename(img.relativePath),
      config,
    );
    allItems.push(...result.items);
  }

  return allItems;
}

/** Extract PDF reference paths from text using a fresh regex instance. */
function collectPdfRefs(
  text: string,
): Array<{ relativePath: string; filename: string; fullMatch: string }> {
  const pattern = new RegExp(PDF_REF_SOURCE, 'g');
  const refs: Array<{
    relativePath: string;
    filename: string;
    fullMatch: string;
  }> = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    refs.push({
      relativePath: match[1],
      filename: path.basename(match[1]),
      fullMatch: match[0],
    });
  }
  return refs;
}

export interface PdfSubstitutionResult {
  prompt: string;
  /** PDFs that could not be extracted — the reference was stripped to prevent
   *  the container from reading the raw file via pdf-reader. */
  failures: MediaCheckFailure[];
}

/**
 * Replace [PDF: ...] references in the prompt with anonymized extracted text.
 * This is deterministic (no Ollama calls) and safe for the streaming path.
 *
 * If extraction fails for a PDF, its reference is STRIPPED (not left in place)
 * to prevent the container from reading the raw, unanonymized file.
 */
export async function substitutePdfContent(
  prompt: string,
  groupDir: string,
  config: AnonymizeConfig,
): Promise<PdfSubstitutionResult> {
  const replacements = collectPdfRefs(prompt);
  if (replacements.length === 0) return { prompt, failures: [] };

  let result = prompt;
  const failures: MediaCheckFailure[] = [];

  for (const rep of replacements) {
    const fullPath = path.join(groupDir, rep.relativePath);
    const filename = path.basename(rep.relativePath);
    const text = await extractPdfText(fullPath);
    if (text) {
      const anonymizedText = anonymize(text, config);
      const substitution = `[PDF content from ${filename}]\n${anonymizedText}\n[End PDF content]`;
      result = result.replace(rep.fullMatch, substitution);
    } else {
      // Strip the reference so the container can't read the raw PDF
      result = result.replace(
        rep.fullMatch,
        `[PDF: ${filename} — could not extract text for PII check, content withheld]`,
      );
      failures.push({ filename, reason: 'text extraction failed' });
      logger.warn(
        { filename },
        'media-pii: PDF reference stripped — extraction failed',
      );
    }
  }

  return { prompt: result, failures };
}

/**
 * Pre-load the Ollama vision model into memory.
 * Fire-and-forget — does not block startup.
 */
export function warmupVisionModel(config: AnonymizeConfig): void {
  if (!(config.mediaPiiCheck ?? config.piiCheck)) return;
  const model = config.piiVisionModel || DEFAULT_VISION_MODEL;
  logger.info({ model }, 'media-pii: warming up vision model');
  fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: 'hi', stream: false }),
  }).catch((err) => {
    logger.warn(
      { err, model },
      'media-pii: vision model warmup failed (model may not be pulled)',
    );
  });
}
