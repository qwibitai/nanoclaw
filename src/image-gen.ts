import fs from 'fs';
import path from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export interface ImageDirective {
  type: 'generate' | 'edit';
  prompt: string;
  sourcePath?: string; // For edit: relative path within group dir
  cleanText: string;
}

// [[image: prompt text here]]
const IMAGE_GEN_RE = /\[\[image:\s*([\s\S]*?)\]\]/i;
// [[image-edit: path/to/source.jpg | prompt text here]]
const IMAGE_EDIT_RE = /\[\[image-edit:\s*([\s\S]*?)\]\]/i;

export function extractImageDirective(text: string): ImageDirective | null {
  const editMatch = text.match(IMAGE_EDIT_RE);
  if (editMatch) {
    const inner = editMatch[1].trim();
    const pipeIdx = inner.indexOf('|');
    if (pipeIdx === -1) return null;
    const sourcePath = inner.slice(0, pipeIdx).trim();
    const prompt = inner.slice(pipeIdx + 1).trim();
    if (!sourcePath || !prompt) return null;
    const cleanText = text.replace(IMAGE_EDIT_RE, '').trim();
    return { type: 'edit', prompt, sourcePath, cleanText };
  }

  const genMatch = text.match(IMAGE_GEN_RE);
  if (genMatch) {
    const prompt = genMatch[1].trim();
    if (!prompt) return null;
    const cleanText = text.replace(IMAGE_GEN_RE, '').trim();
    return { type: 'generate', prompt, cleanText };
  }

  return null;
}

function getApiKey(): string | undefined {
  const env = readEnvFile(['OPENAI_TTS_API_KEY']);
  return process.env.OPENAI_TTS_API_KEY || env.OPENAI_TTS_API_KEY;
}

export async function generateImage(
  prompt: string,
  attachmentsDir: string,
): Promise<string | null> {
  const apiKey = getApiKey();
  if (!apiKey) {
    logger.warn('Image gen: no OPENAI_TTS_API_KEY configured');
    return null;
  }

  const resp = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-image-2',
      prompt,
      n: 1,
      size: '1024x1024',
      quality: 'low',
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    logger.error(
      { status: resp.status, body: body.slice(0, 300) },
      'Image gen failed',
    );
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = await resp.json();
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) {
    logger.error('Image gen: no b64_json in response');
    return null;
  }

  fs.mkdirSync(attachmentsDir, { recursive: true });
  const filename = `image_${Date.now()}.png`;
  const filePath = path.join(attachmentsDir, filename);
  fs.writeFileSync(filePath, Buffer.from(b64, 'base64'));
  logger.info({ filePath, promptLen: prompt.length }, 'Image generated');
  return filePath;
}

export async function editImage(
  sourcePath: string,
  prompt: string,
  attachmentsDir: string,
): Promise<string | null> {
  const apiKey = getApiKey();
  if (!apiKey) {
    logger.warn('Image edit: no OPENAI_TTS_API_KEY configured');
    return null;
  }

  if (!fs.existsSync(sourcePath)) {
    logger.error({ sourcePath }, 'Image edit: source file not found');
    return null;
  }

  const imageBuffer = fs.readFileSync(sourcePath);
  const imageFile = new File([imageBuffer], path.basename(sourcePath), {
    type: 'image/png',
  });

  const form = new FormData();
  form.append('model', 'gpt-image-2');
  form.append('image[]', imageFile);
  form.append('prompt', prompt);
  form.append('size', '1024x1024');
  form.append('quality', 'low');

  let resp: Response;
  try {
    resp = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
  } catch (err) {
    logger.error({ err, sourcePath }, 'Image edit: fetch failed');
    return null;
  }

  if (!resp.ok) {
    const body = await resp.text();
    logger.error(
      { status: resp.status, body: body.slice(0, 300) },
      'Image edit failed',
    );
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = await resp.json();
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) {
    logger.error('Image edit: no b64_json in response');
    return null;
  }

  fs.mkdirSync(attachmentsDir, { recursive: true });
  const filename = `image_${Date.now()}.png`;
  const filePath = path.join(attachmentsDir, filename);
  fs.writeFileSync(filePath, Buffer.from(b64, 'base64'));
  logger.info(
    { filePath, sourcePath, promptLen: prompt.length },
    'Image edited',
  );
  return filePath;
}
