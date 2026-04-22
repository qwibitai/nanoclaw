/**
 * Parse an outbound WeChat reply into an ordered list of text / attachment
 * segments. Supported attachment markers:
 *
 *   ![alt](file:///abs/path)  — markdown image with a `file:` URL
 *   ![alt](/abs/path)         — markdown image with a plain path
 *   <file:/abs/path>          — generic attachment marker (image, pdf, zip…)
 *
 * Paths must be absolute (on the host). The `~` prefix is expanded by the
 * caller. Anything outside these markers is treated as plain text and
 * delivered as a separate TEXT message in order.
 */
export type OutboundSegment =
  | { kind: 'text'; text: string }
  | { kind: 'attachment'; filePath: string };

const MARKDOWN_IMG_RE = /!\[[^\]]*\]\(((?:file:\/\/)?[^)\s]+)\)/g;
const FILE_TAG_RE = /<file:([^>\s]+)>/g;

function isAttachmentPath(raw: string): string | null {
  let path = raw.trim();
  if (path.startsWith('file://')) path = path.slice('file://'.length);
  if (!path) return null;
  if (path.startsWith('/') || path.startsWith('~')) return path;
  return null;
}

interface Marker {
  start: number;
  end: number;
  path: string;
}

function collectMarkers(text: string): Marker[] {
  const markers: Marker[] = [];
  for (const re of [MARKDOWN_IMG_RE, FILE_TAG_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const resolved = isAttachmentPath(m[1]);
      if (!resolved) continue;
      markers.push({
        start: m.index,
        end: m.index + m[0].length,
        path: resolved,
      });
    }
  }
  return markers.sort((a, b) => a.start - b.start);
}

export function parseOutboundSegments(text: string): OutboundSegment[] {
  const markers = collectMarkers(text);
  if (markers.length === 0) {
    const trimmed = text.trim();
    return trimmed ? [{ kind: 'text', text: trimmed }] : [];
  }

  const out: OutboundSegment[] = [];
  let cursor = 0;
  for (const m of markers) {
    if (m.start > cursor) {
      const chunk = text.slice(cursor, m.start).trim();
      if (chunk) out.push({ kind: 'text', text: chunk });
    }
    out.push({ kind: 'attachment', filePath: m.path });
    cursor = m.end;
  }
  if (cursor < text.length) {
    const tail = text.slice(cursor).trim();
    if (tail) out.push({ kind: 'text', text: tail });
  }
  return out;
}
