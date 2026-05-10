/**
 * Modules barrel.
 *
 * Each module self-registers at import time. This barrel is imported by
 * src/index.ts for side effects (registry registrations, typing impl setup,
 * etc.). Core runs with an empty barrel — the registries have inline
 * fallbacks and `sqlite_master` guards.
 *
 * Default modules (ship with main, direct core import):
 *   - src/modules/typing/        → imported directly by router/delivery/container-runner
 *   - src/modules/mount-security/ → imported directly by container-runner
 *
 * Registry-based modules (installed via /add-<name> skills, pulled from the
 * `modules` branch): append imports below.
 */
// Approvals (default tier) must load before self-mod (optional) so the
// registerApprovalHandler / requestApproval symbols are bound when self-mod
// registers its handlers at import time.
import './approvals/index.js';
import './interactive/index.js';
import './scheduling/index.js';
import './permissions/index.js';
import './agent-to-agent/index.js';
import './self-mod/index.js';
import './remote-control/index.js';
import './channel-auto-wire/index.js';
// Bash-gate depends on approvals (registers an approval handler) and on
// the delivery action registry being up — both satisfied by the order above.
import './bash-gate/index.js';
// Orchestrator dispatch — task dispatch pipeline + reconciler.
import './orchestrator-dispatch/index.js';
// Backlog + ship-log delivery action handlers (add_ship_log, add/update/delete_backlog_item).
import './backlog/index.js';
// Channel-config registers delivery actions for set_channel_model /
// set_channel_effort. Depends on permissions (for isAdminOfAgentGroup).
import './channel-config/index.js';
