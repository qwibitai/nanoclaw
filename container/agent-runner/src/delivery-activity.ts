import fs from 'fs';
import path from 'path';

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function hasVisibleReply(text: string | null | undefined): boolean {
  if (!text) return false;
  return stripInternalTags(text).length > 0;
}

export function appendSendMessageActivity(
  filePath: string | undefined,
  text: string,
): void {
  if (!filePath || !text.trim()) return;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, '1\n', 'utf8');
}

export function resetSendMessageActivity(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '', 'utf8');
}

export function consumeSendMessageCount(filePath: string): number {
  if (!fs.existsSync(filePath)) return 0;

  const raw = fs.readFileSync(filePath, 'utf8');
  const count = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean).length;

  resetSendMessageActivity(filePath);

  return count;
}
