/**
 * Delivery-action handlers for agent-initiated self-modification requests.
 *
 * Two actions the container can write into messages_out (via the self-mod
 * MCP tools): install_packages, add_mcp_server. Each one validates input
 * and queues an approval request. The admin's approval triggers the
 * matching approval handler in ./apply.ts, which also performs the
 * required follow-up (rebuild+restart for install_packages, restart-only
 * for add_mcp_server).
 *
 * Host-side sanitization for install_packages is defense-in-depth — the MCP
 * tool validates first. Both layers matter: the DB row carries the payload
 * verbatim through to shell exec on apply.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent, requestApproval } from '../approvals/index.js';

export async function handleInstallPackages(content: Record<string, unknown>, session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notifyAgent(session, 'install_packages failed: agent group not found.');
    return;
  }

  const apt = (content.apt as string[]) || [];
  const npm = (content.npm as string[]) || [];
  const reason = (content.reason as string) || '';

  const APT_RE = /^[a-z0-9][a-z0-9._+-]*$/;
  const NPM_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
  const MAX_PACKAGES = 20;
  if (apt.length + npm.length === 0) {
    notifyAgent(session, 'install_packages failed: at least one apt or npm package is required.');
    return;
  }
  if (apt.length + npm.length > MAX_PACKAGES) {
    notifyAgent(session, `install_packages failed: max ${MAX_PACKAGES} packages per request.`);
    return;
  }
  const invalidApt = apt.find((p) => !APT_RE.test(p));
  if (invalidApt) {
    notifyAgent(session, `install_packages failed: invalid apt package name "${invalidApt}".`);
    log.warn('install_packages: invalid apt package rejected', { pkg: invalidApt });
    return;
  }
  const invalidNpm = npm.find((p) => !NPM_RE.test(p));
  if (invalidNpm) {
    notifyAgent(session, `install_packages failed: invalid npm package name "${invalidNpm}".`);
    log.warn('install_packages: invalid npm package rejected', { pkg: invalidNpm });
    return;
  }

  const packageList = [...apt.map((p) => `apt: ${p}`), ...npm.map((p) => `npm: ${p}`)].join(', ');
  await requestApproval({
    session,
    agentName: agentGroup.name,
    action: 'install_packages',
    payload: { apt, npm, reason },
    title: 'Install Packages Request',
    question: `Agent "${agentGroup.name}" is attempting to install a package + rebuild container:\n${packageList}${reason ? `\nReason: ${reason}` : ''}`,
  });
}

export async function handleInstallPlugin(content: Record<string, unknown>, session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notifyAgent(session, 'install_plugin failed: agent group not found.');
    return;
  }

  const pluginSpec = content.plugin_spec as string;
  if (!pluginSpec || !pluginSpec.includes('@')) {
    notifyAgent(session, 'install_plugin failed: plugin_spec must be in "name@marketplace" format.');
    return;
  }
  const [, marketplace] = pluginSpec.split('@');
  if (!marketplace) {
    notifyAgent(session, 'install_plugin failed: marketplace name missing after "@".');
    return;
  }

  // Validate inline source if provided. Use the same validator the operator
  // skills use, so the same schema rules apply for agent-initiated installs.
  let validatedSource: unknown = null;
  if (content.source) {
    try {
      const { parseMarketplaceSource } = await import('../plugins/source-validator.js');
      validatedSource = parseMarketplaceSource(content.source);
    } catch (err) {
      notifyAgent(session, `install_plugin failed: ${err instanceof Error ? err.message : String(err)}`);
      log.warn('install_plugin: invalid source rejected', { spec: pluginSpec, err });
      return;
    }
  }

  const reason = (content.reason as string) || '';
  const sourceDesc = validatedSource ? ` (with inline source: ${JSON.stringify(validatedSource).slice(0, 100)})` : '';
  await requestApproval({
    session,
    agentName: agentGroup.name,
    action: 'install_plugin',
    payload: { plugin_spec: pluginSpec, source: validatedSource, reason },
    title: 'Install Plugin Request',
    question: `Agent "${agentGroup.name}" wants to install plugin:\n${pluginSpec}${sourceDesc}${reason ? `\nReason: ${reason}` : ''}\n\nThe plugin will be cloned and loaded by the SDK at next session start. Container will restart on approval.`,
  });
}

export async function handleUninstallPlugin(content: Record<string, unknown>, session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notifyAgent(session, 'uninstall_plugin failed: agent group not found.');
    return;
  }
  const pluginSpec = content.plugin_spec as string;
  if (!pluginSpec || !pluginSpec.includes('@')) {
    notifyAgent(session, 'uninstall_plugin failed: plugin_spec must be in "name@marketplace" format.');
    return;
  }
  const reason = (content.reason as string) || '';
  await requestApproval({
    session,
    agentName: agentGroup.name,
    action: 'uninstall_plugin',
    payload: { plugin_spec: pluginSpec, reason },
    title: 'Uninstall Plugin Request',
    question: `Agent "${agentGroup.name}" wants to disable plugin:\n${pluginSpec}${reason ? `\nReason: ${reason}` : ''}\n\nThe marketplace registration stays so other plugins from it remain installable. Container will restart on approval.`,
  });
}

export async function handleAddMcpServer(content: Record<string, unknown>, session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notifyAgent(session, 'add_mcp_server failed: agent group not found.');
    return;
  }
  const serverName = content.name as string;
  const command = content.command as string;
  if (!serverName || !command) {
    notifyAgent(session, 'add_mcp_server failed: name and command are required.');
    return;
  }
  await requestApproval({
    session,
    agentName: agentGroup.name,
    action: 'add_mcp_server',
    payload: {
      name: serverName,
      command,
      args: (content.args as string[]) || [],
      env: (content.env as Record<string, string>) || {},
    },
    title: 'Add MCP Request',
    question: `Agent "${agentGroup.name}" is attempting to add a new MCP server:\n${serverName} (${command})`,
  });
}
