# Intent: Add Discord channel import

Add `import './discord.js';` to the channel barrel file so the Discord
module self-registers with the channel registry on startup.

This is an append-only change — existing import lines for other channels
must be preserved.
