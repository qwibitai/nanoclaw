/**
 * VOSS CRM MCP Server — Node.js implementation.
 * Calls the VOSS API over HTTP. Used by NanoClaw containers.
 *
 * Env vars: VOSS_API_URL, VOSS_API_KEY
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_URL = (process.env.VOSS_API_URL || 'http://localhost:8000').replace(/\/$/, '');
const API_KEY = process.env.VOSS_API_KEY || '';

async function apiGet(path: string, params?: Record<string, string>): Promise<unknown> {
  let url = `${API_URL}${path}`;
  if (params) {
    const filtered = Object.entries(params).filter(([, v]) => v);
    if (filtered.length) url += '?' + new URLSearchParams(filtered).toString();
  }
  const resp = await fetch(url, {
    headers: { 'X-API-Key': API_KEY },
  });
  if (!resp.ok) throw new Error(`API error ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

async function apiPost(path: string, data: Record<string, unknown>): Promise<unknown> {
  const resp = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: JSON.stringify(data),
  });
  if (!resp.ok) throw new Error(`API error ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

async function apiPut(path: string, data: Record<string, unknown>): Promise<unknown> {
  const resp = await fetch(`${API_URL}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: JSON.stringify(data),
  });
  if (!resp.ok) throw new Error(`API error ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

function stripEmpty(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== '' && v !== undefined));
}

const server = new McpServer({ name: 'voss-crm', version: '1.0.0' });

// --- Contacts ---

server.tool('search_contacts', 'Search contacts by name, email, company, role, or tags', {
  query: z.string(),
}, async ({ query }) => {
  const results = await apiGet('/api/contacts', { q: query });
  return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
});

server.tool('get_contact_details', 'Get full profile for a contact including interactions, deals, and follow-ups', {
  contact_id: z.string(),
}, async ({ contact_id }) => {
  const contact = await apiGet(`/api/contacts/${contact_id}`);
  const deals = await apiGet('/api/deals', { contact_id });
  const followUps = await apiGet('/api/follow-ups', { contact_id, status: 'pending' });
  const interactions = await apiGet('/api/interactions', { contact_id, limit: '10' });
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ contact, deals, follow_ups: followUps, recent_interactions: interactions }, null, 2),
    }],
  };
});

server.tool('create_contact', 'Create a new contact in the CRM', {
  first_name: z.string(),
  last_name: z.string().optional().default(''),
  email: z.string().optional().default(''),
  phone: z.string().optional().default(''),
  role: z.string().optional().default(''),
  company_name: z.string().optional().default(''),
  source: z.string().optional().default(''),
  tags: z.string().optional().default(''),
  notes: z.string().optional().default(''),
  segment: z.string().optional().default(''),
  engagement_stage: z.string().optional().default('new'),
  inbound_channel: z.string().optional().default(''),
}, async (args) => {
  const data = stripEmpty(args);
  data.first_name = args.first_name; // always required
  const result = await apiPost('/api/contacts', data);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

// --- Deals ---

server.tool('get_pipeline', 'Get an overview of all deals grouped by stage with values', {}, async () => {
  const deals = await apiGet('/api/deals');
  return { content: [{ type: 'text', text: JSON.stringify(deals, null, 2) }] };
});

server.tool('get_deal', 'Get full details about a specific deal', {
  deal_id: z.string(),
}, async ({ deal_id }) => {
  const deal = await apiGet(`/api/deals/${deal_id}`);
  return { content: [{ type: 'text', text: JSON.stringify(deal, null, 2) }] };
});

server.tool('update_deal_stage', 'Move a deal to a new pipeline stage. Valid stages: lead, prospect, qualified, proposal, negotiation, won, lost', {
  deal_id: z.string(),
  stage: z.string(),
}, async ({ deal_id, stage }) => {
  const deal = await apiPut(`/api/deals/${deal_id}`, { stage });
  return { content: [{ type: 'text', text: JSON.stringify(deal, null, 2) }] };
});

server.tool('create_deal', 'Create a new deal. Accepts contact/company names (resolved automatically)', {
  title: z.string(),
  contact_name: z.string().optional().default(''),
  company_name: z.string().optional().default(''),
  stage: z.string().optional().default('lead'),
  value: z.string().optional().default(''),
  currency: z.string().optional().default('GBP'),
  priority: z.string().optional().default('medium'),
  expected_close: z.string().optional().default(''),
  notes: z.string().optional().default(''),
}, async (args) => {
  const data = stripEmpty(args);
  data.title = args.title;
  const deal = await apiPost('/api/deals', data);
  return { content: [{ type: 'text', text: JSON.stringify(deal, null, 2) }] };
});

server.tool('update_deal', 'Update an existing deal. Only provided fields are changed', {
  deal_id: z.string(),
  title: z.string().optional().default(''),
  contact_name: z.string().optional().default(''),
  company_name: z.string().optional().default(''),
  stage: z.string().optional().default(''),
  value: z.string().optional().default(''),
  currency: z.string().optional().default(''),
  priority: z.string().optional().default(''),
  expected_close: z.string().optional().default(''),
  notes: z.string().optional().default(''),
}, async ({ deal_id, ...rest }) => {
  const data = stripEmpty(rest);
  if (Object.keys(data).length === 0) return { content: [{ type: 'text', text: 'No fields to update.' }] };
  const deal = await apiPut(`/api/deals/${deal_id}`, data);
  return { content: [{ type: 'text', text: JSON.stringify(deal, null, 2) }] };
});

// --- Follow-ups ---

server.tool('get_follow_ups', 'Get follow-ups, optionally filtered by status, overdue, or contact', {
  status: z.string().optional().default('pending'),
  overdue_only: z.boolean().optional().default(false),
  contact_id: z.string().optional().default(''),
}, async ({ status, overdue_only, contact_id }) => {
  const params: Record<string, string> = { status: status || 'pending' };
  if (contact_id) params.contact_id = contact_id;
  let results = await apiGet('/api/follow-ups', params) as Array<Record<string, string>>;
  if (overdue_only) {
    const today = new Date().toISOString().split('T')[0];
    results = results.filter(f => (f.due_date || '') < today);
  }
  return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
});

server.tool('create_follow_up', 'Schedule a new follow-up for a contact. due_date format: YYYY-MM-DD', {
  contact_id: z.string(),
  title: z.string(),
  due_date: z.string(),
  due_time: z.string().optional().default(''),
  deal_id: z.string().optional().default(''),
  notes: z.string().optional().default(''),
}, async (args) => {
  const data = stripEmpty(args);
  data.contact_id = args.contact_id;
  data.title = args.title;
  data.due_date = args.due_date;
  const fup = await apiPost('/api/follow-ups', data);
  return { content: [{ type: 'text', text: JSON.stringify(fup, null, 2) }] };
});

server.tool('complete_follow_up', 'Mark a follow-up as completed', {
  follow_up_id: z.string(),
}, async ({ follow_up_id }) => {
  const fup = await apiPut(`/api/follow-ups/${follow_up_id}`, { status: 'completed' });
  return { content: [{ type: 'text', text: JSON.stringify(fup, null, 2) }] };
});

// --- Interactions ---

server.tool('log_interaction', 'Log an interaction (call, email, meeting, or note) with a contact', {
  contact_id: z.string(),
  type: z.string(),
  subject: z.string(),
  body: z.string().optional().default(''),
  direction: z.string().optional().default(''),
  deal_id: z.string().optional().default(''),
}, async (args) => {
  const data = stripEmpty(args);
  data.contact_id = args.contact_id;
  data.type = args.type;
  data.subject = args.subject;
  const result = await apiPost('/api/interactions', data);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('get_interaction_history', 'Get recent interaction history, optionally filtered by contact or deal', {
  contact_id: z.string().optional().default(''),
  deal_id: z.string().optional().default(''),
  limit: z.number().optional().default(20),
}, async ({ contact_id, deal_id, limit }) => {
  const params: Record<string, string> = {};
  if (contact_id) params.contact_id = contact_id;
  if (deal_id) params.deal_id = deal_id;
  if (limit !== 20) params.limit = String(limit);
  const results = await apiGet('/api/interactions', params);
  return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
});

// --- Dashboard ---

server.tool('get_dashboard_summary', 'Get a high-level CRM dashboard: pipeline summary, overdue follow-ups, today\'s tasks, and recent activity', {}, async () => {
  const summary = await apiGet('/api/dashboard/summary');
  return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
});

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
