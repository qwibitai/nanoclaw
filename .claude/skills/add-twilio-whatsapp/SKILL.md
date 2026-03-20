---
name: add-twilio-whatsapp
description: Add Twilio WhatsApp as a channel. Uses Twilio's official WhatsApp Business API with webhook for inbound and REST API for outbound. Supports text and image messages. Triggers on "add twilio", "twilio whatsapp", "twilio channel".
---

# Add Twilio WhatsApp Channel

This skill adds Twilio-based WhatsApp support to NanoClaw, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/channels/twilio-whatsapp.ts` exists. If it does, skip to Phase 3 (Setup). The code changes are already in place.

### Prerequisites

- A Twilio account with a WhatsApp-enabled number (sandbox or production)
- A way to expose the webhook to the internet (cloud server, ngrok, or Cloudflare Tunnel)

## Phase 2: Apply Code Changes

### Merge the skill branch

```bash
git fetch upstream skill/twilio-whatsapp
git merge upstream/skill/twilio-whatsapp || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in:
- `src/channels/twilio-whatsapp.ts` (TwilioWhatsAppChannel with webhook server, image send/receive)
- `import './twilio-whatsapp.js'` appended to `src/channels/index.ts`
- `twilio` npm dependency in `package.json`

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Validate code changes

```bash
npm install
npm run build
```

Build must be clean before proceeding.

## Phase 3: Setup

### Collect Twilio Credentials

Use `AskUserQuestion` to collect:

1. **Twilio Account SID** — found on the Twilio Console dashboard (starts with `AC`)
2. **Twilio Auth Token** — found on the Twilio Console dashboard
3. **Twilio WhatsApp Number** — the WhatsApp-enabled number in format `whatsapp:+14155238886`

If the user doesn't have a WhatsApp number yet, guide them:

> To get started with Twilio WhatsApp:
>
> **Sandbox (free testing):**
> 1. Go to [Twilio Console > Messaging > Try it out > Send a WhatsApp message](https://console.twilio.com/us1/develop/sms/try-it-out/whatsapp-learn)
> 2. Follow the sandbox setup — you'll get a shared number like `whatsapp:+14155238886`
> 3. Each user must send a join code to the sandbox number first
>
> **Production:**
> 1. Go to [Twilio Console > Messaging > Senders > WhatsApp senders](https://console.twilio.com/us1/develop/sms/senders/whatsapp-senders)
> 2. Register your own business number

Add credentials to `.env`:

```bash
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
```

### Configure Webhook

Use `AskUserQuestion`: How will you expose the webhook to the internet?

- **Cloud server with public IP/domain**: Use your server's public URL directly
- **ngrok**: Run `ngrok http 3002` and copy the HTTPS URL
- **Cloudflare Tunnel**: Run `cloudflared tunnel --url http://localhost:3002` and copy the URL

Once the user has a public URL, add to `.env`:

```bash
TWILIO_WEBHOOK_PORT=3002
TWILIO_WEBHOOK_URL=https://your-public-url/webhook
```

Tell the user to configure this URL in Twilio:
> Set your webhook URL in the Twilio Console:
>
> **Sandbox:** Go to [Twilio Console > Messaging > Try it out > WhatsApp sandbox settings](https://console.twilio.com/us1/develop/sms/settings/whatsapp-sandbox) and set "When a message comes in" to your webhook URL.
>
> **Production:** Go to your WhatsApp Sender configuration and set the webhook URL.

### Optional: Acknowledgement Message

Use `AskUserQuestion`: Would you like the bot to send an immediate "Message received" response while it processes?

If yes, add to `.env`:

```bash
TWILIO_ACK_MESSAGE=Message received, thinking...
```

### Register WhatsApp Numbers

Use `AskUserQuestion`: Enter the WhatsApp phone numbers that should be able to message this bot (comma-separated, with country code).

Example: `+6598204137, +6512345678`

For each phone number provided:

1. Ask for a friendly name (e.g., "Srinath", "Family Group")
2. Sanitize the phone number for the folder name (strip `+` and non-digits)
3. Determine if this should be the main group:
   - Check if a main group already exists. If not, ask: "Should this be your main control chat (no trigger word needed)?"
4. Register:

```bash
npx tsx setup/index.ts --step register -- \
  --jid "whatsapp:+PHONE" \
  --name "NAME" \
  --folder "twilio_SANITIZED_PHONE" \
  --trigger "@${ASSISTANT_NAME}" \
  --channel twilio-whatsapp \
  --no-trigger-required \
  --assistant-name "${ASSISTANT_NAME}"
```

Add `--is-main` if this is the main group.

5. Create a CLAUDE.md for each registered group:

```markdown
# Twilio WhatsApp Channel

You are communicating via WhatsApp (Twilio). You can both receive and send images.

## Sending Images

To send an image back to the user, reference it using the format:
[Image: attachments/filename.jpg]

The image will be delivered as an actual WhatsApp image, not as text.

## Receiving Images

When a user sends an image, it appears as [Image: attachments/img-XXXX.jpg]. The image file is saved in your workspace at that path.
```

### Build and Restart

```bash
npm run build
```

Restart the service:
```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

## Phase 4: Verify

Tell the user:

> Send a WhatsApp message to your Twilio number from one of the registered phone numbers.
>
> You should see:
> 1. An immediate acknowledgement (if configured)
> 2. The bot's response after processing

Check logs:
```bash
tail -20 logs/nanoclaw.log | grep -i twilio
```

## Troubleshooting

- **"Twilio WhatsApp: credentials not set, skipping"**: Check `.env` has all three: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`
- **No messages arriving**: Check that `TWILIO_WEBHOOK_URL` is set in both `.env` and Twilio Console. Verify the tunnel is running.
- **"Invalid signature" errors**: Ensure `TWILIO_WEBHOOK_URL` in `.env` matches exactly what's configured in Twilio Console (including trailing `/webhook`)
- **Messages arrive but no response**: Check the phone number is registered. Run the register step again if needed.
- **Images not sending**: Ensure `TWILIO_WEBHOOK_URL` is set — image serving requires a public URL for Twilio to fetch from.

## Important Notes

- **Phone number changes**: If a user changes their phone number, you'll need to register the new number and the old JID will become stale. Run this skill again to add the new number.
- **Sandbox limitations**: The Twilio sandbox uses a shared number with rate limits. Each user must send a join code first. For production use, register your own WhatsApp Business number.
- **24-hour session window**: WhatsApp Business API requires users to have messaged within 24 hours for the bot to reply. The bot cannot initiate conversations outside this window without approved templates.
