# Intent: Add Matrix channel import

Add `import './matrix.js';` to the channel barrel file so the Matrix
module self-registers with the channel registry on startup.

This is an append-only change — existing import lines for other channels
must be preserved.
