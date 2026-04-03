import { GoogleGenerativeAI } from '@google/generative-ai';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const envConfig = readEnvFile(['GEMINI_API_KEY']);
const apiKey = process.env.GEMINI_API_KEY || envConfig.GEMINI_API_KEY || '';

const GEMINI_MAX_VIDEO_MB = 20;

export function isGeminiEnabled(): boolean {
  return !!apiKey;
}

export async function analyzeImage(
  buffer: Buffer,
  mimeType?: string,
  caption?: string,
): Promise<string | null> {
  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash-latest' });

    const prompt = caption
      ? `Describe this image in detail. The sender included this caption: "${caption}"`
      : 'Describe this image in detail.';

    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          data: buffer.toString('base64'),
          mimeType: mimeType || 'image/jpeg',
        },
      },
    ]);

    const text = result.response.text();
    return text || null;
  } catch (err) {
    logger.error({ err }, 'Gemini image analysis failed');
    return null;
  }
}

export async function analyzeVideo(
  buffer: Buffer,
  mimeType: string,
  caption?: string,
): Promise<string | null> {
  try {
    const sizeMB = buffer.length / (1024 * 1024);
    if (sizeMB > GEMINI_MAX_VIDEO_MB) {
      return `Video too large for analysis (>${GEMINI_MAX_VIDEO_MB}MB)`;
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash-latest' });

    const prompt = caption
      ? `Describe this video in detail. The sender included this caption: "${caption}"`
      : 'Describe this video in detail.';

    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          data: buffer.toString('base64'),
          mimeType,
        },
      },
    ]);

    const text = result.response.text();
    return text || null;
  } catch (err) {
    logger.error({ err }, 'Gemini video analysis failed');
    return null;
  }
}
