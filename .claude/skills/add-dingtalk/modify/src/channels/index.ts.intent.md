# Intent: Add DingTalk channel import

Add `import './dingtalk.js';` to the channel barrel file so the DingTalk
module self-registers on startup.

This is append-only. Existing imports for other channels must stay intact.
