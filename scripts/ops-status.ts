/**
 * CLI: npm run ops:status
 * Outputs JSON with OS operational status.
 */
import { initDatabase } from '../src/db.js';
import { POLICY_VERSION } from '../src/governance/policy-version.js';
import {
  countTasksByState,
  countTasksByProduct,
  countExtCallsByProvider,
  getWipLoad,
  getFailedDispatches,
  getL3CallsLast24h,
} from '../src/ops-metrics.js';

initDatabase();

const status = {
  os_version: POLICY_VERSION,
  generated_at: new Date().toISOString(),
  tasks: {
    by_state: countTasksByState(),
    by_product: countTasksByProduct(),
  },
  ext_calls: {
    by_provider: countExtCallsByProvider(),
    l3_last_24h: getL3CallsLast24h(),
  },
  wip_load: getWipLoad(),
  failed_dispatches: getFailedDispatches(),
};

console.log(JSON.stringify(status, null, 2));
