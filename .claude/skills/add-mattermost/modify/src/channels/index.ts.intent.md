# Intent: Add Mattermost channel import

Add `import './mattermost.js';` to the channel barrel file so the Mattermost
module self-registers with the channel registry on startup.

This is an append-only change — existing import lines for other channels
must be preserved.
