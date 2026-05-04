// Provider self-registration barrel.
// Each import triggers the provider module's registerProvider() call at top
// level. Skills add a new provider by appending one import line below.

import './claude.js';
import './codex.js';
import './mock.js';
// opencode.js dropped from this spike — requires @opencode-ai/sdk dep we
// don't need for the air-gapped use case. Add back when wiring Phase C.
