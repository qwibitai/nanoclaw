# QQBot Channel Registration Tool

Interactive tool to register QQBot chats with NanoClaw.

## Usage

1. **Send a test message** to your QQBot to get the OpenID
2. **Check logs** to find the JID:
   ```bash
   tail -f logs/nanoclaw.log | grep "QQBot: Message from unregistered"
   ```
   You'll see something like: `QQBot: Message from unregistered chat` with `jid: "c2c:ABCDEF1234567890..."`

3. **Run the registration tool**:
   ```bash
   npx tsx src/channels/register-qqbot.ts
   ```

   Or compile first:
   ```bash
   npx tsc src/channels/register-qqbot.ts --module nodenext --moduleResolution nodenext --target es2022
   node src/channels/register-qqbot.js
   ```

4. **Follow the prompts**:
   - Enter the JID (e.g., `c2c:5548DC0BD7300B93A824CEBA235E597C`)
   - Enter a chat name (e.g., "QQ Personal")
   - Enter a folder name (e.g., "qq-main")
   - Enter trigger pattern (e.g., "@yourbot")
   - Choose whether to respond to all messages (y/n)

5. **Restart NanoClaw**:
   ```bash
   systemctl --user restart nanoclaw
   ```

6. **Test**: Send a message to your QQBot!

## JID Formats

- **C2C (Private)**: `c2c:OPENID` (32-character hex string)
- **Group**: `group:OPENID` (32-character hex string)
- **Channel**: `channel:CHANNELID`

## Notes

- The OpenID is NOT your QQ number - it's a privacy-preserving identifier
- In sandbox mode, only C2C (private) messages are supported
- For production bots, group and channel support requires bot approval
