export interface EmailFullData {
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
  attachments: Array<{ name: string; size: string }>;
  cc?: string;
  emailId?: string;
  account?: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderEmailFull(data: EmailFullData): string {
  const attachmentsHtml =
    data.attachments.length > 0
      ? `<div style="border-top:1px solid #21262d;padding-top:12px;margin-top:12px;"><div style="font-size:11px;color:#484f58;margin-bottom:8px;">ATTACHMENTS</div>${data.attachments.map((a) => `<div style="font-size:13px;color:#58a6ff;">📎 ${escapeHtml(a.name)} (${escapeHtml(a.size)})</div>`).join('')}</div>`
      : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(data.subject)}</title>
  <style>
    body { background: #0d1117; color: #c9d1d9; font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 16px; }
    .header { border-bottom: 1px solid #21262d; padding-bottom: 12px; margin-bottom: 16px; }
    .subject { font-size: 18px; font-weight: 600; margin-bottom: 8px; }
    .meta { font-size: 12px; color: #8b949e; line-height: 1.6; }
    .body { font-size: 14px; line-height: 1.6; }
    .actions { border-top: 1px solid #21262d; padding-top: 12px; margin-top: 16px; display: flex; gap: 8px; }
    .btn { background: #21262d; color: #c9d1d9; padding: 8px 16px; border-radius: 6px; border: none; font-size: 13px; cursor: pointer; }
  </style>
</head>
<body>
  <div class="header">
    <div class="subject">${escapeHtml(data.subject)}</div>
    <div class="meta">
      <div><b>From:</b> ${escapeHtml(data.from)}</div>
      <div><b>To:</b> ${escapeHtml(data.to)}</div>
      ${data.cc ? `<div><b>CC:</b> ${escapeHtml(data.cc)}</div>` : ''}
      <div><b>Date:</b> ${escapeHtml(data.date)}</div>
    </div>
  </div>
  <div class="body">
  <iframe
    sandbox=""
    srcdoc="${escapeHtml(data.body)}"
    style="width:100%;border:none;min-height:300px;background:#0d1117;color-scheme:dark;"
    onload="this.style.height=this.contentDocument.body.scrollHeight+'px'"
  ></iframe>
</div>
  ${attachmentsHtml}
  <div class="actions">
    <button class="btn" style="background:#276749;color:#c6f6d5;">Archive</button>
    <button class="btn">Open in Gmail</button>
  </div>
</body>
</html>`;
}
