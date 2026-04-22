---
name: add-weixin
description: Add WeChat (微信) as a channel. Uses the iLink bot protocol (ported from Tencent's @tencent-weixin/openclaw-weixin plugin). Supports QR-code login and text message send/receive. This skill walks through base-URL configuration, QR login, and registering the main chat.
---

# Add WeChat Channel

This skill adds WeChat (微信) support to NanoClaw. It is a direct port of the
HTTP protocol used by Tencent's official OpenClaw WeChat plugin — rewritten
to plug into NanoClaw's `Channel` interface with no OpenClaw SDK dependency.

The code is shipped in-tree under `src/channels/weixin/` and self-registers
via `src/channels/weixin.ts`. No git branch merge is required.

## Phase 1: Pre-flight

### Check installation state

Verify the code is present (it ships with this NanoClaw checkout):

```bash
ls src/channels/weixin/ && ls src/channels/weixin.ts
```

If any of these are missing, this skill is not applicable — the port was
removed or never applied. Stop and ask the user.

### iLink base URL (optional)

The login script defaults to Tencent's public iLink backend
(`https://ilinkai.weixin.qq.com`), which is the same endpoint the official
`@tencent-weixin/openclaw-weixin` plugin uses. No approval or onboarding is
required — anyone with a WeChat account can scan a bot QR and log in.

Only override this if you're pointing at a staging/private deployment:

```bash
echo "WEIXIN_BASE_URL=<url>" >> .env
```

## Phase 2: Apply Configuration

### Install optional dep

Terminal QR rendering uses `qrcode-terminal`. Install it if missing:

```bash
npm install --save qrcode-terminal
```

(If the user says "no new dependencies", the login script falls back to
printing the QR URL in plain text — users can scan from another device that
has a QR renderer.)

### Build

```bash
npm run build
```

### Run tests

```bash
npx vitest run src/channels/weixin.test.ts
```

All tests must pass before continuing.

## Phase 3: QR Login

Run the interactive login script:

```bash
npx tsx scripts/weixin-login.ts
```

Walk the user through:

1. The script fetches a QR code from `WEIXIN_BASE_URL`.
2. It prints the QR in the terminal. User scans it with WeChat.
3. After scanning, the terminal shows `👀 已扫码，请在微信中继续确认...`.
4. User confirms on phone.
5. On success, the script prints `✅ 与微信连接成功！` plus `accountId` and
   `userId`. These are saved to `store/weixin/accounts/<accountId>.account.json`.

If the QR expires, the script auto-refreshes up to 3 times.

## Phase 4: Register the Main Chat

The bot only receives and replies to users who have had at least one
prior message exchange (iLink requires a `context_token` obtained from
an inbound message before outbound is accepted).

1. Have the user send any test message to the bot on WeChat.
2. NanoClaw logs show: `inbound message: from=<userId>`.
3. The chat JID is `wx:<userId>`. Register it as the main group:

```bash
npx tsx -e "
import { setRegisteredGroup, initDatabase } from './src/db.js';
initDatabase();
setRegisteredGroup('wx:<userId>', {
  name: 'WeChat Main',
  folder: 'main',
  trigger: '',
  added_at: new Date().toISOString(),
  isMain: true,
  requiresTrigger: false,
});
"
```

Replace `<userId>` with the actual iLink user id.

4. Restart NanoClaw so the channel connects:

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# or: systemctl --user restart nanoclaw           # Linux
```

## Phase 5: Verify

User sends another message on WeChat. The agent should reply. Check logs:

```bash
tail -f logs/nanoclaw.log | grep weixin
```

## Architecture Notes

- **JID scheme**: `wx:<ilink_user_id>`. 1:1 direct chats only (WeChat iLink
  bot protocol does not currently expose group chats).
- **context_token**: Required by the iLink server on every outbound message.
  The channel caches the most recent token per user in
  `store/weixin/accounts/<accountId>.context-tokens.json` and refreshes it
  from every inbound message.
- **Session expiry (errcode -14)**: After 7+ days of inactivity the server
  revokes the session. The monitor sleeps 1 hour and retries; permanent
  recovery needs a fresh QR login.
- **Outbound media**: image / video / generic file attachments are sent via
  the iLink CDN (AES-128-ECB upload, then a dedicated `sendmessage` with an
  IMAGE / VIDEO / FILE item). MIME type is derived from the file extension
  (see `media/mime.ts`). The agent triggers a media send by embedding one of
  these markers in its reply text:
    - `![alt](/abs/host/path.png)` — markdown image syntax
    - `![](file:///abs/host/path.png)` — `file://` URL form
    - `<file:/abs/host/path.pdf>` — generic attachment (any MIME)
  Paths must be absolute on the host. The container-local shortcut
  `/workspace/group/…` is auto-translated to the host `groups/<folder>/…`
  path by `WeixinChannel.resolveContainerPath`, so agents writing output
  files to their CWD can reference them with just the container path.
- **Inbound media**: image / video / file / voice are still surfaced to the
  agent as `[图片]` / `[视频]` / `[文件]` / `[语音]` placeholders. Decoding
  the inbound CDN payload and SILK voice transcoding remain open tasks.
- **Multi-account**: The storage layout supports it (`store/weixin/accounts/*`)
  but the current `WeixinChannel` registers only the default account. To run
  multiple bots, extend the factory in `src/channels/weixin.ts`.

## Troubleshooting

- **QR fetch fails**: Check `WEIXIN_BASE_URL` is reachable from the host
  (`curl $WEIXIN_BASE_URL/ilink/bot/get_bot_qrcode?bot_type=3`).
- **"session paused 1h"** in logs: session expired (errcode -14). Re-run
  `scripts/weixin-login.ts` and restart NanoClaw.
- **"weixin sendMessage: no contextToken cached"**: the bot hasn't received
  a message from that user yet. The first outbound can only follow an
  inbound — this is a protocol constraint.
