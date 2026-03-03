# Intent: Add Signal channel import

Add `import './signal.js';` to the channel barrel file so the Signal
module self-registers with the channel registry on startup.

This is an append-only change — existing import lines for other channels
must be preserved.
