# Intent: Add Slack channel import

Add `import './slack.js';` to the channel barrel file so the Slack
module self-registers with the channel registry on startup.

This is an append-only change — existing import lines for other channels
must be preserved.
