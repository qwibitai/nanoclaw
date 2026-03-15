/**
 * Agent CRUD routes.
 */
import {
  createAgent,
  deleteAgent,
  getAgent,
  getAllAgents,
  getActivityLog,
  updateAgent,
  logActivity,
  PortalAgent,
} from '../db-portal.js';
import {
  provisionAgent,
  updateAgentClaudeMd,
} from '../services/agent-provisioner.js';
import { json, error, RequestContext } from '../server.js';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 48);
}

export async function handleAgentRoutes(ctx: RequestContext): Promise<void> {
  const { method, pathname, body, res } = ctx;

  // GET /api/agents
  if (method === 'GET' && pathname === '/api/agents') {
    const agents = getAllAgents();
    json(res, agents);
    return;
  }

  // POST /api/agents
  if (method === 'POST' && pathname === '/api/agents') {
    const data = body as Partial<PortalAgent> & { name: string };
    if (!data?.name) {
      error(res, 'Agent name is required');
      return;
    }

    const groupFolder = `viv_${slugify(data.name)}`;

    const agent = createAgent({
      name: data.name,
      display_name: data.display_name || data.name,
      role: data.role || 'dedicated',
      client_id: data.client_id || null,
      client_name: data.client_name || null,
      group_folder: groupFolder,
      specializations: data.specializations || '[]',
      triage_config: data.triage_config || '{}',
      custom_instructions: data.custom_instructions || null,
      status: 'active',
    });

    // Provision filesystem + CLAUDE.md
    provisionAgent(agent);

    // Log activity
    logActivity({
      agent_id: agent.id,
      ticket_id: null,
      ticket_display_id: null,
      action_type: 'agent_created',
      detail: JSON.stringify({ name: agent.name, role: agent.role }),
      client_id: agent.client_id,
      duration_ms: null,
    });

    json(res, agent, 201);
    return;
  }

  // Routes with agent ID: /api/agents/:id[/...]
  const agentIdMatch = pathname.match(/^\/api\/agents\/([^/]+)(\/.*)?$/);
  if (!agentIdMatch) {
    error(res, 'Not Found', 404);
    return;
  }

  const agentId = agentIdMatch[1];
  const subPath = agentIdMatch[2] || '';

  // GET /api/agents/:id
  if (method === 'GET' && subPath === '') {
    const agent = getAgent(agentId);
    if (!agent) {
      error(res, 'Agent not found', 404);
      return;
    }
    json(res, agent);
    return;
  }

  // PUT /api/agents/:id
  if (method === 'PUT' && subPath === '') {
    const agent = getAgent(agentId);
    if (!agent) {
      error(res, 'Agent not found', 404);
      return;
    }

    const data = body as Partial<PortalAgent>;
    updateAgent(agentId, {
      name: data.name,
      display_name: data.display_name,
      role: data.role,
      client_id: data.client_id,
      client_name: data.client_name,
      specializations: data.specializations,
      triage_config: data.triage_config,
      custom_instructions: data.custom_instructions,
      status: data.status,
    });

    // Regenerate CLAUDE.md
    const updated = getAgent(agentId)!;
    updateAgentClaudeMd(updated);

    logActivity({
      agent_id: agentId,
      ticket_id: null,
      ticket_display_id: null,
      action_type: 'agent_updated',
      detail: JSON.stringify(data),
      client_id: updated.client_id,
      duration_ms: null,
    });

    json(res, updated);
    return;
  }

  // DELETE /api/agents/:id
  if (method === 'DELETE' && subPath === '') {
    const agent = getAgent(agentId);
    if (!agent) {
      error(res, 'Agent not found', 404);
      return;
    }

    deleteAgent(agentId);

    logActivity({
      agent_id: agentId,
      ticket_id: null,
      ticket_display_id: null,
      action_type: 'agent_deleted',
      detail: JSON.stringify({ name: agent.name }),
      client_id: agent.client_id,
      duration_ms: null,
    });

    json(res, { ok: true });
    return;
  }

  // POST /api/agents/:id/start
  if (method === 'POST' && subPath === '/start') {
    updateAgent(agentId, { status: 'active' });
    const updated = getAgent(agentId);
    json(res, updated);
    return;
  }

  // POST /api/agents/:id/pause
  if (method === 'POST' && subPath === '/pause') {
    updateAgent(agentId, { status: 'paused' });
    const updated = getAgent(agentId);
    json(res, updated);
    return;
  }

  // GET /api/agents/:id/activity
  if (method === 'GET' && subPath === '/activity') {
    const limit = parseInt(ctx.url.searchParams.get('limit') || '50', 10);
    const offset = parseInt(ctx.url.searchParams.get('offset') || '0', 10);
    const activities = getActivityLog({ agent_id: agentId, limit, offset });
    json(res, activities);
    return;
  }

  error(res, 'Not Found', 404);
}
