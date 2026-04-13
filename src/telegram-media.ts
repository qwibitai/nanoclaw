import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { transcribeWithOpenAI } from './transcription.js';

const execFileAsync = promisify(execFile);

const TRANSCRIPTION_CONFIG = {
  model: 'whisper-1' as const,
  enabled: true,
  fallbackMessage: '[Voice message - transcription unavailable]',
};

/**
 * Download a file from Telegram's CDN.
 */
export async function downloadTelegramFile(
  botToken: string,
  filePath: string,
): Promise<Buffer> {
  const url = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Telegram file download failed: ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Transcribe a Telegram voice message.
 * Returns the transcript text or a fallback message.
 */
export async function transcribeTelegramVoice(
  botToken: string,
  fileId: string,
): Promise<string> {
  try {
    const fileRes = await fetch(
      `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`,
    );
    const fileData = (await fileRes.json()) as {
      ok: boolean;
      result?: { file_path: string };
    };
    if (!fileData.ok || !fileData.result?.file_path) {
      return TRANSCRIPTION_CONFIG.fallbackMessage;
    }

    const buffer = await downloadTelegramFile(
      botToken,
      fileData.result.file_path,
    );
    logger.info({ bytes: buffer.length }, 'Downloaded Telegram voice message');

    const transcript = await transcribeWithOpenAI(buffer, TRANSCRIPTION_CONFIG);
    if (!transcript) {
      return TRANSCRIPTION_CONFIG.fallbackMessage;
    }
    return transcript.trim();
  } catch (err) {
    logger.error({ err }, 'Telegram voice transcription error');
    return TRANSCRIPTION_CONFIG.fallbackMessage;
  }
}

/**
 * Describe a Telegram photo using the Anthropic API.
 * Returns a brief text description or null on failure.
 */
export async function describeTelegramImage(
  botToken: string,
  fileId: string,
): Promise<string | null> {
  const env = readEnvFile(['ANTHROPIC_API_KEY']);
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.warn('ANTHROPIC_API_KEY not set — cannot describe image');
    return null;
  }

  try {
    const fileRes = await fetch(
      `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`,
    );
    const fileData = (await fileRes.json()) as {
      ok: boolean;
      result?: { file_path: string };
    };
    if (!fileData.ok || !fileData.result?.file_path) return null;

    const buffer = await downloadTelegramFile(
      botToken,
      fileData.result.file_path,
    );
    const base64 = buffer.toString('base64');

    // Determine media type from file extension
    const ext = fileData.result.file_path.split('.').pop()?.toLowerCase();
    const mediaType =
      ext === 'png'
        ? 'image/png'
        : ext === 'gif'
          ? 'image/gif'
          : ext === 'webp'
            ? 'image/webp'
            : 'image/jpeg';

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: mediaType, data: base64 },
              },
              {
                type: 'text',
                text: 'Describe this image in 1-2 concise sentences. Focus on what is shown, not artistic qualities.',
              },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      logger.error({ status: res.status }, 'Anthropic image describe failed');
      return null;
    }

    const data = (await res.json()) as {
      content: Array<{ type: string; text?: string }>;
    };
    const text = data.content?.find((c) => c.type === 'text')?.text;
    return text?.trim() || null;
  } catch (err) {
    logger.error({ err }, 'Telegram image description error');
    return null;
  }
}

/**
 * Extract text from a PDF buffer using pdftotext.
 * Returns extracted text or null if pdftotext is unavailable.
 */
export async function extractPdfText(buffer: Buffer): Promise<string | null> {
  const tmpFile = path.join(os.tmpdir(), `nanoclaw-pdf-${Date.now()}.pdf`);
  try {
    fs.writeFileSync(tmpFile, buffer);
    const { stdout } = await execFileAsync('pdftotext', [
      '-layout',
      tmpFile,
      '-',
    ]);
    return stdout.trim() || null;
  } catch (err) {
    logger.error(
      { err },
      'PDF text extraction failed (is poppler-utils installed?)',
    );
    return null;
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // ignore cleanup errors
    }
  }
}

/**
 * Download and extract text from a Telegram PDF document.
 */
export async function extractTelegramPdf(
  botToken: string,
  fileId: string,
): Promise<string | null> {
  try {
    const fileRes = await fetch(
      `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`,
    );
    const fileData = (await fileRes.json()) as {
      ok: boolean;
      result?: { file_path: string };
    };
    if (!fileData.ok || !fileData.result?.file_path) return null;

    const buffer = await downloadTelegramFile(
      botToken,
      fileData.result.file_path,
    );
    logger.info({ bytes: buffer.length }, 'Downloaded Telegram PDF');

    return await extractPdfText(buffer);
  } catch (err) {
    logger.error({ err }, 'Telegram PDF extraction error');
    return null;
  }
}
