# Intent: Add WhatsApp channel import

Add `import './whatsapp.js';` to the channel barrel file so the WhatsApp
module self-registers with the channel registry on startup.

This is an append-only change — existing import lines for other channels
must be preserved.
