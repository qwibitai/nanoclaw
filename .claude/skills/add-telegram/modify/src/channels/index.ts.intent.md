# Intent: Add Telegram channel import

Add `import './telegram.js';` to the channel barrel file so the Telegram
module self-registers with the channel registry on startup.

This is an append-only change — existing import lines for other channels
must be preserved.
