/**
 * Media dispatch — routes content parts to type-specific handlers.
 *
 * Handler convention:
 *   Input:  (filePath: string) — absolute path to the media file
 *   Output: Promise<ContentBlock[] | null> — content blocks for Claude, or null to fall through
 *
 * Each media type has its own handler file (e.g. image.ts, voice.ts).
 * Handler files are "managers" that list and call skill implementations:
 *   - voice.ts calls voice-openai.ts (Whisper transcription)
 *   - file.ts calls pdf-extract.ts (pdftotext extraction)
 *
 * Skills follow the same convention: take a filePath, return content blocks or null.
 * If all skills return null, the handler returns null, and dispatch falls back to
 * a generic text note ("User sent X file. Stored at Y.").
 *
 * To add a new handler: create a handler file and add a case to the switch.
 * To add a skill for an existing type: create a skill file and import it in the handler.
 * Skills override by replacing the handler or skill file on their branch.
 */
import fs from 'fs';

import { handleImage } from './image.js';
import { handleFile } from './file.js';
import { handleVoice } from './voice.js';
import { handleAudio } from './audio.js';
import { handleVideo } from './video.js';
import { handleSticker } from './sticker.js';

const MEDIA_DIR = '/workspace/group/media';
const MEDIA_MAX_MB = 500;
const MEDIA_MAX_BYTES = MEDIA_MAX_MB * 1024 * 1024;

export interface ContentPart {
  type: string;
  path?: string;
  text?: string;
  filename?: string;
}

type ContentBlock = any;
type MessageContent = string | ContentBlock[];

function log(message: string): void {
  console.error(`[dispatch] ${message}`);
}

async function dispatchContentPart(part: ContentPart): Promise<ContentBlock[]> {
  if (!part.path) return [];
  const fullPath = `/workspace/group/${part.path}`;

  try {
    let result: ContentBlock[] | null = null;

    switch (part.type) {
      case 'image':
        result = await handleImage(fullPath);
        break;
      case 'file':
        result = await handleFile(fullPath);
        break;
      case 'voice':
        result = await handleVoice(fullPath);
        break;
      case 'audio':
        result = await handleAudio(fullPath);
        break;
      case 'video':
        result = await handleVideo(fullPath);
        break;
      case 'sticker':
        result = await handleSticker(fullPath);
        break;
    }

    if (result?.length) return result;
  } catch (err) {
    log(
      `Handler for ${part.type} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Fallback: text note for unhandled or failed types
  if (fs.existsSync(fullPath)) {
    const label = part.type.charAt(0).toUpperCase() + part.type.slice(1);
    return [
      { type: 'text', text: `User sent ${label} file. Stored at ${fullPath}.` },
    ];
  }

  log(`Media file not found: ${fullPath}`);
  return [];
}

/**
 * Build message content from text and optional structured content parts.
 * Dispatches each media part through its handler and combines with text.
 */
export async function buildMessageContent(
  text: string,
  contentParts?: ContentPart[],
): Promise<MessageContent> {
  cleanupMedia();
  if (!contentParts?.length) return text;

  const blocks: ContentBlock[] = [];
  if (text.trim()) blocks.push({ type: 'text', text: text.trim() });

  for (const part of contentParts) {
    const dispatched = await dispatchContentPart(part);
    blocks.push(...dispatched);
  }

  return blocks.length === 1 && blocks[0].type === 'text'
    ? blocks[0].text
    : blocks;
}

/**
 * Prevent media files from accumulating indefinitely.
 * If total size exceeds the threshold, evict oldest files first.
 */
function cleanupMedia(): void {
  if (!fs.existsSync(MEDIA_DIR)) return;

  const files = fs.readdirSync(MEDIA_DIR).map((name) => {
    const filepath = `${MEDIA_DIR}/${name}`;
    const stat = fs.statSync(filepath);
    return { filepath, mtimeMs: stat.mtimeMs, size: stat.size };
  });

  let totalSize = files.reduce((sum, f) => sum + f.size, 0);
  if (totalSize <= MEDIA_MAX_BYTES) return;

  files.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
  for (const f of files) {
    if (totalSize <= MEDIA_MAX_BYTES) break;
    fs.unlinkSync(f.filepath);
    totalSize -= f.size;
  }
}
