/**
 * Team management routes.
 */
import {
  createTeam,
  deleteTeam,
  getTeam,
  getAllTeams,
  updateTeam,
  addTeamMember,
  removeTeamMember,
  getTeamMembers,
  createEscalationRule,
  getEscalationRules,
  deleteEscalationRule,
  PortalTeam,
  PortalTeamMember,
  PortalEscalationRule,
} from '../db-portal.js';
import { json, error, RequestContext } from '../server.js';

export async function handleTeamRoutes(ctx: RequestContext): Promise<void> {
  const { method, pathname, body, res } = ctx;

  // GET /api/teams
  if (method === 'GET' && pathname === '/api/teams') {
    const teams = getAllTeams();
    // Enrich with member counts
    const enriched = teams.map((t) => ({
      ...t,
      members: getTeamMembers(t.id),
      escalation_rules: getEscalationRules(t.id),
    }));
    json(res, enriched);
    return;
  }

  // POST /api/teams
  if (method === 'POST' && pathname === '/api/teams') {
    const data = body as Partial<PortalTeam> & { name: string };
    if (!data?.name) {
      error(res, 'Team name is required');
      return;
    }
    const team = createTeam({
      name: data.name,
      description: data.description || null,
      team_type: data.team_type || 'client',
    });
    json(res, team, 201);
    return;
  }

  // Routes with team ID
  const teamIdMatch = pathname.match(/^\/api\/teams\/([^/]+)(\/.*)?$/);
  if (!teamIdMatch) {
    error(res, 'Not Found', 404);
    return;
  }

  const teamId = teamIdMatch[1];
  const subPath = teamIdMatch[2] || '';

  // GET /api/teams/:id
  if (method === 'GET' && subPath === '') {
    const team = getTeam(teamId);
    if (!team) {
      error(res, 'Team not found', 404);
      return;
    }
    json(res, {
      ...team,
      members: getTeamMembers(teamId),
      escalation_rules: getEscalationRules(teamId),
    });
    return;
  }

  // PUT /api/teams/:id
  if (method === 'PUT' && subPath === '') {
    const team = getTeam(teamId);
    if (!team) {
      error(res, 'Team not found', 404);
      return;
    }
    const data = body as Partial<PortalTeam>;
    updateTeam(teamId, {
      name: data.name,
      description: data.description,
      team_type: data.team_type,
    });
    json(res, getTeam(teamId));
    return;
  }

  // DELETE /api/teams/:id
  if (method === 'DELETE' && subPath === '') {
    deleteTeam(teamId);
    json(res, { ok: true });
    return;
  }

  // POST /api/teams/:id/members
  if (method === 'POST' && subPath === '/members') {
    const data = body as Partial<PortalTeamMember>;
    if (!data?.agent_id) {
      error(res, 'agent_id is required');
      return;
    }
    addTeamMember({
      team_id: teamId,
      agent_id: data.agent_id,
      role: data.role || 'member',
      escalation_order: data.escalation_order || null,
      trigger_categories: data.trigger_categories || null,
    });
    json(res, getTeamMembers(teamId), 201);
    return;
  }

  // DELETE /api/teams/:id/members/:agentId
  const memberMatch = subPath.match(/^\/members\/([^/]+)$/);
  if (method === 'DELETE' && memberMatch) {
    removeTeamMember(teamId, memberMatch[1]);
    json(res, { ok: true });
    return;
  }

  // POST /api/teams/:id/rules
  if (method === 'POST' && subPath === '/rules') {
    const data = body as Partial<PortalEscalationRule>;
    if (!data?.condition_type || !data?.condition_value || !data?.target_agent_id) {
      error(res, 'condition_type, condition_value, and target_agent_id are required');
      return;
    }
    const rule = createEscalationRule({
      team_id: teamId,
      condition_type: data.condition_type,
      condition_value: data.condition_value,
      target_agent_id: data.target_agent_id,
      action: data.action || 'escalate',
    });
    json(res, rule, 201);
    return;
  }

  // DELETE /api/teams/:id/rules/:ruleId
  const ruleMatch = subPath.match(/^\/rules\/([^/]+)$/);
  if (method === 'DELETE' && ruleMatch) {
    deleteEscalationRule(ruleMatch[1]);
    json(res, { ok: true });
    return;
  }

  error(res, 'Not Found', 404);
}
