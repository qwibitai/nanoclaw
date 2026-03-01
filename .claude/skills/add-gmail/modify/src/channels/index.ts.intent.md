# Intent: Add Gmail channel import

Add `import './gmail.js';` to the channel barrel file so the Gmail
module self-registers with the channel registry on startup.

This is an append-only change — existing import lines for other channels
must be preserved.
