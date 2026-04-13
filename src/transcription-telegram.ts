import { Bot } from 'grammy';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export async function transcribeTelegramVoice(
  bot: Bot,
  ctx: any,
): Promise<string | null> {
  const env = readEnvFile(['OPENAI_API_KEY']);
  const apiKey = env.OPENAI_API_KEY;

  if (!apiKey) {
    logger.warn('OPENAI_API_KEY not set — voice transcription unavailable');
    return null;
  }

  try {
    // Get the file from Telegram
    const file = await ctx.getFile();
    const url = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;

    // Download the voice file
    const resp = await fetch(url);
    if (!resp.ok) {
      logger.error({ status: resp.status }, 'Failed to download voice file');
      return null;
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    logger.debug({ bytes: buffer.length }, 'Downloaded voice file');

    // Send to OpenAI Whisper API
    const formData = new FormData();
    formData.append('file', new Blob([buffer], { type: 'audio/ogg' }), 'voice.ogg');
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'text');

    const whisperResp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: formData,
    });

    if (!whisperResp.ok) {
      const err = await whisperResp.text();
      logger.error({ status: whisperResp.status, err }, 'Whisper API error');
      return null;
    }

    const transcript = await whisperResp.text();
    return transcript.trim() || null;
  } catch (err) {
    logger.error({ err }, 'Telegram voice transcription failed');
    return null;
  }
}
