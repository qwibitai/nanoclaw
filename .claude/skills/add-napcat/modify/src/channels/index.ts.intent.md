# Intent: Add NapCat channel import

Add `import './napcat.js';` to the channel barrel file so the NapCat
module self-registers with the channel registry on startup.

This is an append-only change — existing import lines for other channels
must be preserved.
