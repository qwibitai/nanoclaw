/**
 * Approval handlers for self-modification actions.
 *
 * The approvals module calls these when an admin clicks Approve on a
 * pending_approvals row whose action matches. Each handler mutates the
 * container config, rebuilds/kills the container as needed, and lets the
 * host sweep respawn it on the new image on the next message.
 *
 * install_packages: rebuild image + kill container (apt/npm global installs
 *   must be baked into the image layer).
 * add_mcp_server: kill container only — bun runs TS directly, so a pure
 *   MCP wiring change needs nothing more than a process restart.
 */
import { updateContainerConfig } from '../../container-config.js';
import { buildAgentGroupImage, killContainer } from '../../container-runner.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { ApprovalHandler } from '../approvals/index.js';
import { installPlugin, uninstallPlugin } from '../plugins/config.js';

export const applyInstallPackages: ApprovalHandler = async ({ session, payload, userId, notify }) => {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notify('install_packages approved but agent group missing.');
    return;
  }
  await updateContainerConfig(agentGroup.folder, (cfg) => {
    if (payload.apt) cfg.packages.apt.push(...(payload.apt as string[]));
    if (payload.npm) cfg.packages.npm.push(...(payload.npm as string[]));
  });

  const pkgs = [
    ...((payload.apt as string[] | undefined) || []),
    ...((payload.npm as string[] | undefined) || []),
  ].join(', ');
  log.info('Package install approved', { agentGroupId: session.agent_group_id, userId });
  try {
    await buildAgentGroupImage(session.agent_group_id);
    killContainer(session.id, 'rebuild applied');
    // Schedule a follow-up prompt a few seconds after kill so the host sweep
    // respawns the container on the new image and the agent verifies + reports.
    writeSessionMessage(session.agent_group_id, session.id, {
      id: `appr-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({
        text: `Packages installed (${pkgs}) and container rebuilt. Verify the new packages are available (e.g. run them or check versions) and report the result to the user.`,
        sender: 'system',
        senderId: 'system',
      }),
      processAfter: new Date(Date.now() + 5000)
        .toISOString()
        .replace('T', ' ')
        .replace(/\.\d+Z$/, ''),
    });
    log.info('Container rebuild completed (bundled with install)', { agentGroupId: session.agent_group_id });
  } catch (e) {
    notify(
      `Packages added to config (${pkgs}) but rebuild failed: ${e instanceof Error ? e.message : String(e)}. Tell the user — an admin will need to retry the install_packages request or inspect the build logs.`,
    );
    log.error('Bundled rebuild failed after install approval', { agentGroupId: session.agent_group_id, err: e });
  }
};

export const applyInstallPlugin: ApprovalHandler = async ({ session, payload, userId, notify }) => {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notify('install_plugin approved but agent group missing.');
    return;
  }

  const pluginSpec = payload.plugin_spec as string;
  const inlineSource = (payload.source as Parameters<typeof installPlugin>[2]) || undefined;

  let result;
  try {
    result = await installPlugin(agentGroup.folder, pluginSpec, inlineSource);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notify(`install_plugin failed: ${msg}`);
    log.error('install_plugin apply error', { agentGroupId: session.agent_group_id, err });
    return;
  }

  log.info('Plugin install approved', { agentGroupId: session.agent_group_id, userId, pluginSpec });
  killContainer(session.id, 'install_plugin applied');
  // Schedule a follow-up so the new container reports the install outcome
  // back to chat. SDK plugin_install events fire at session init; we want
  // the agent to verify and report success/failure to the user.
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `appr-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({
      text: `Plugin "${pluginSpec}" install ${result.marketplaceAdded ? '+ marketplace registration ' : ''}applied. Container restarting. On next message, check whether the plugin's tools/skills appear in your context — if a plugin_install:failed log line was emitted, surface the error to the user.`,
      sender: 'system',
      senderId: 'system',
    }),
    processAfter: new Date(Date.now() + 5000)
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d+Z$/, ''),
  });
};

export const applyUninstallPlugin: ApprovalHandler = async ({ session, payload, userId, notify }) => {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notify('uninstall_plugin approved but agent group missing.');
    return;
  }

  const pluginSpec = payload.plugin_spec as string;
  let result;
  try {
    result = await uninstallPlugin(agentGroup.folder, pluginSpec);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notify(`uninstall_plugin failed: ${msg}`);
    log.error('uninstall_plugin apply error', { agentGroupId: session.agent_group_id, err });
    return;
  }

  if (!result.wasDisabled) {
    notify(`Plugin "${pluginSpec}" was not enabled. No change.`);
    return;
  }

  log.info('Plugin uninstall approved', { agentGroupId: session.agent_group_id, userId, pluginSpec });
  killContainer(session.id, 'uninstall_plugin applied');
  notify(`Plugin "${pluginSpec}" disabled. Your container will restart with the new config on the next message.`);
};

export const applyAddMcpServer: ApprovalHandler = async ({ session, payload, userId, notify }) => {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notify('add_mcp_server approved but agent group missing.');
    return;
  }
  await updateContainerConfig(agentGroup.folder, (cfg) => {
    cfg.mcpServers[payload.name as string] = {
      command: payload.command as string,
      args: (payload.args as string[]) || [],
      env: (payload.env as Record<string, string>) || {},
    };
  });

  killContainer(session.id, 'mcp server added');
  notify(`MCP server "${payload.name}" added. Your container will restart with it on the next message.`);
  log.info('MCP server add approved', { agentGroupId: session.agent_group_id, userId });
};
