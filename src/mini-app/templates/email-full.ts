export interface EmailFullData {
  mode?: 'view' | 'reply'; // default: 'view' (backward compatible)
  draftId?: string; // required when mode === 'reply'
  account?: string; // used by both reply mode and view-mode archive button
  emailId?: string; // used by view-mode archive button
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
  attachments: Array<{ name: string; size: string }>;
  cc?: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderEmailFull(data: EmailFullData): string {
  const mode = data.mode ?? 'view';
  const attachmentsHtml =
    data.attachments.length > 0
      ? `<div style="border-top:1px solid #21262d;padding-top:12px;margin-top:12px;"><div style="font-size:11px;color:#484f58;margin-bottom:8px;">ATTACHMENTS</div>${data.attachments.map((a) => `<div style="font-size:13px;color:#58a6ff;">📎 ${escapeHtml(a.name)} (${escapeHtml(a.size)})</div>`).join('')}</div>`
      : '';

  const viewControls = `<div class="body">
  <iframe
    sandbox=""
    srcdoc="${escapeHtml(data.body)}"
    style="width:100%;border:none;min-height:300px;background:#0d1117;color-scheme:dark;"
    onload="this.style.height=this.contentDocument.body.scrollHeight+'px'"
  ></iframe>
</div>
  ${attachmentsHtml}
  <div class="actions">
  <button class="btn" style="background:#276749;color:#c6f6d5;"
    data-email-id="${escapeHtml(data.emailId || '')}"
    data-account="${escapeHtml(data.account || '')}"
    onclick="archiveEmail(this)">Archive</button>
  <a class="btn" href="https://mail.google.com/mail/u/0/#inbox/${escapeHtml(data.emailId || '')}"
    target="_blank" rel="noopener" style="text-decoration:none;display:inline-block;">Open in Gmail</a>
</div>
<script>
async function archiveEmail(btn) {
  btn.disabled = true;
  btn.textContent = 'Archiving...';
  try {
    const resp = await fetch('/api/email/' + btn.dataset.emailId + '/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: btn.dataset.account }),
    });
    if (resp.ok) {
      btn.textContent = 'Archived';
      btn.style.opacity = '0.5';
      if (window.Telegram && window.Telegram.WebApp) window.Telegram.WebApp.close();
    } else {
      btn.textContent = 'Failed - Retry';
      btn.disabled = false;
    }
  } catch(e) {
    btn.textContent = 'Failed - Retry';
    btn.disabled = false;
  }
}
</script>`;

  const replyControls =
    mode === 'reply' && data.draftId && data.account
      ? renderReplyControls(data.draftId, data.account, data.body)
      : viewControls;

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
    .actions { border-top: 1px solid #21262d; padding-top: 12px; margin-top: 16px; display: flex; gap: 8px; flex-wrap: wrap; }
    .btn { background: #21262d; color: #c9d1d9; padding: 8px 16px; border-radius: 6px; border: none; font-size: 13px; cursor: pointer; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .compose { width: 100%; box-sizing: border-box; background: #0d1117; color: #c9d1d9; border: 1px solid #21262d; border-radius: 6px; padding: 12px; font-size: 14px; font-family: inherit; resize: vertical; min-height: 180px; }
    .undo-banner { display: none; border-top: 1px solid #21262d; padding-top: 12px; margin-top: 16px; color: #c9d1d9; font-size: 14px; }
    .undo-banner .countdown { color: #58a6ff; font-weight: 600; }
    .err { color: #f85149; font-size: 12px; margin-top: 8px; }
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
  ${replyControls}
</body>
</html>`;
}

function renderReplyControls(
  draftId: string,
  account: string,
  draftBody: string,
): string {
  return `
  <textarea id="compose" class="compose" placeholder="Agent's draft — edit before sending">${escapeHtml(draftBody)}</textarea>
  <div class="err" id="err" style="display:none"></div>
  <div class="actions" id="actions">
    <button class="btn" id="send-btn" style="background:#1f6feb;color:#fff;">Send</button>
    <button class="btn" id="edit-gmail-btn">Edit in Gmail</button>
    <button class="btn" id="archive-btn" style="background:#276749;color:#c6f6d5;">Archive</button>
  </div>
  <div class="undo-banner" id="undo-banner">
    Sending in <span class="countdown" id="countdown">10</span>s —
    <button class="btn" id="undo-btn" style="background:#f85149;color:#fff;margin-left:8px;">Undo</button>
  </div>
  <script>
    (function(){
      const draftId = ${JSON.stringify(draftId)};
      const account = ${JSON.stringify(account)};
      const compose = document.getElementById('compose');
      const sendBtn = document.getElementById('send-btn');
      const editBtn = document.getElementById('edit-gmail-btn');
      const archiveBtn = document.getElementById('archive-btn');
      const actions = document.getElementById('actions');
      const banner = document.getElementById('undo-banner');
      const undoBtn = document.getElementById('undo-btn');
      const countdown = document.getElementById('countdown');
      const err = document.getElementById('err');
      let countdownTimer = null;

      function showError(msg){ err.textContent = msg; err.style.display = 'block'; }
      function clearError(){ err.style.display = 'none'; }
      async function saveBody(){
        clearError();
        const res = await fetch('/api/draft/' + encodeURIComponent(draftId) + '/save', {
          method: 'PATCH',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ body: compose.value }),
        });
        const j = await res.json();
        if (!j.ok) throw new Error(j.error || 'Save failed');
      }

      sendBtn.addEventListener('click', async () => {
        try {
          sendBtn.disabled = true;
          await saveBody();
          const res = await fetch('/api/draft/' + encodeURIComponent(draftId) + '/send', {
            method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}',
          });
          const j = await res.json();
          if (!j.ok) throw new Error(j.error || 'Send failed');
          actions.style.display = 'none';
          banner.style.display = 'block';
          let remaining = 10;
          countdown.textContent = remaining;
          countdownTimer = setInterval(() => {
            remaining -= 1;
            if (remaining <= 0) {
              clearInterval(countdownTimer);
              banner.innerHTML = '<span style="color:#6ca368;">Sent.</span>';
              setTimeout(() => { banner.style.display = 'none'; }, 3000);
            } else {
              countdown.textContent = remaining;
            }
          }, 1000);
        } catch (e) {
          sendBtn.disabled = false;
          showError(String(e.message || e));
        }
      });

      undoBtn.addEventListener('click', async () => {
        try {
          const res = await fetch('/api/draft/' + encodeURIComponent(draftId) + '/send/cancel', {
            method: 'POST',
          });
          const j = await res.json();
          if (countdownTimer) clearInterval(countdownTimer);
          if (j.cancelled) {
            banner.style.display = 'none';
            actions.style.display = 'flex';
            sendBtn.disabled = false;
          } else {
            banner.innerHTML = '<span style="color:#f85149;">Too late — already sent.</span>';
          }
        } catch (e) {
          showError(String(e.message || e));
        }
      });

      editBtn.addEventListener('click', async () => {
        try {
          await saveBody();
          const url = 'https://mail.google.com/mail/u/' + encodeURIComponent(account) + '/#drafts?compose=' + encodeURIComponent(draftId);
          window.open(url, '_blank');
        } catch (e) {
          showError(String(e.message || e));
        }
      });

      archiveBtn.addEventListener('click', () => {
        // Existing archive pathway: Telegram callback handles it; close mini-app.
        window.close();
      });
    })();
  </script>
  `;
}
