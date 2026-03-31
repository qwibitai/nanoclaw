import { Attachment } from './types.js';

/**
 * Build a safe, unique filename for a downloaded attachment.
 *
 * Logic:
 * - If sender provided a filename, prefix with sanitized ID to avoid collisions
 * - If the attachment ID already has a recognized extension (some channels
 *   include it), use the sanitized ID as-is
 * - Otherwise: sanitized ID + MIME-derived extension
 */
export function buildAttachmentFilename(attachment: Attachment): string {
  const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, '_');

  if (attachment.filename) {
    return `${sanitize(attachment.id)}-${sanitize(attachment.filename)}`;
  }

  if (/\.\w{2,5}$/.test(attachment.id)) {
    return sanitize(attachment.id);
  }

  return `${sanitize(attachment.id)}-attachment.${mimeToExt(attachment.contentType)}`;
}

export function mimeToExt(contentType: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'audio/aac': 'aac',
    'audio/mp4': 'm4a',
    'application/pdf': 'pdf',
  };
  return map[contentType] || 'bin';
}
