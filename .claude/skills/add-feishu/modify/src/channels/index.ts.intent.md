# Intent: Add Feishu channel import

Add `import './feishu.js';` to the channel barrel file so the Feishu
module self-registers with the channel registry on startup.

This is an append-only change — existing import lines for other channels
must be preserved.

Do not remove, reorder, or rewrite unrelated channel imports.
