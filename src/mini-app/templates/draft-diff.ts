export interface DraftDiffData {
  draftId: string;
  account: string;
  originalBody: string;
  enrichedBody: string | null;
  enrichedAt: string;
}

export function renderDraftDiff(data: DraftDiffData): string {
  const escHtml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Draft Diff</title>
  <style>
    body { background: #1a1a2e; color: #e0e0e0; font-family: -apple-system, sans-serif; margin: 0; padding: 16px; }
    h2 { color: #a78bfa; margin-bottom: 4px; }
    .meta { color: #888; font-size: 0.85rem; margin-bottom: 16px; }
    .diff-container { display: flex; gap: 12px; flex-wrap: wrap; }
    .diff-panel { flex: 1; min-width: 280px; background: #16213e; border-radius: 8px; padding: 12px; }
    .diff-panel h3 { margin-top: 0; font-size: 0.9rem; }
    .original h3 { color: #f87171; }
    .enriched h3 { color: #34d399; }
    pre { white-space: pre-wrap; word-break: break-word; font-size: 0.85rem; line-height: 1.5; }
    .btn { display: inline-block; margin-top: 16px; padding: 10px 20px; background: #f87171; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 0.9rem; }
    .btn:hover { background: #ef4444; }
  </style>
</head>
<body>
  <h2>Draft Diff</h2>
  <div class="meta">${escHtml(data.account)} · enriched ${escHtml(data.enrichedAt)}</div>
  <div class="diff-container">
    <div class="diff-panel original">
      <h3>Original</h3>
      <pre>${escHtml(data.originalBody)}</pre>
    </div>
    <div class="diff-panel enriched">
      <h3>Enriched</h3>
      <pre>${data.enrichedBody ? escHtml(data.enrichedBody) : '<em>Could not load current draft</em>'}</pre>
    </div>
  </div>
</body>
</html>`;
}
