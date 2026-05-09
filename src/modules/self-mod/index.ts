/**
 * Self-modification module — admin-approved container mutations.
 *
 * Optional tier. Depends on the approvals default module for the request/
 * handler plumbing. On install the module registers:
 *   - Two delivery actions (install_packages, add_mcp_server) that validate
 *     input and queue an approval via requestApproval().
 *   - Two matching approval handlers that run on approve and perform the
 *     complete follow-up:
 *       install_packages → update container.json, rebuild image, kill
 *         container (next wake respawns on the new image), schedule a
 *         verify-and-report follow-up prompt.
 *       add_mcp_server → update container.json, kill container. No image
 *         rebuild — bun runs TS directly, so the new MCP server is wired
 *         by the next container start.
 *
 * Without this module: the MCP tools in the container still write outbound
 * system messages with these actions, but delivery logs "Unknown system
 * action" and drops them. Admin never sees a card; nothing changes.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { registerApprovalHandler } from '../approvals/index.js';
import { applyAddMcpServer, applyInstallPackages, applyInstallPlugin, applyUninstallPlugin } from './apply.js';
import { handleAddMcpServer, handleInstallPackages, handleInstallPlugin, handleUninstallPlugin } from './request.js';

registerDeliveryAction('install_packages', handleInstallPackages);
registerDeliveryAction('add_mcp_server', handleAddMcpServer);
registerDeliveryAction('install_plugin', handleInstallPlugin);
registerDeliveryAction('uninstall_plugin', handleUninstallPlugin);

// Dedupe denial loops on agent-initiated self-mods. Without this flag the
// response handler never records a denial row on Reject, so the request-side
// gate has nothing to find and the same approval card wakes the admin again
// on the next agent retry. Pair with `dedupeDenials: true` in each
// requestApproval call (src/modules/self-mod/request.ts).
registerApprovalHandler('install_packages', applyInstallPackages, { dedupeDenials: true });
registerApprovalHandler('add_mcp_server', applyAddMcpServer, { dedupeDenials: true });
registerApprovalHandler('install_plugin', applyInstallPlugin, { dedupeDenials: true });
registerApprovalHandler('uninstall_plugin', applyUninstallPlugin, { dedupeDenials: true });
