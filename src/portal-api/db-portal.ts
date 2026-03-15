/**
 * Portal-specific database operations.
 * Extends the NanoClaw SQLite database with portal tables.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import { STORE_DIR } from '../config.js';
import { logger } from '../logger.js';

let db: Database.Database;

// --- Types ---

export interface PortalAgent {
  id: string;
  name: string;
  display_name: string | null;
  role: 'dedicated' | 'specialist' | 'cyber' | 'custom';
  client_id: number | null;
  client_name: string | null;
  group_folder: string;
  specializations: string; // JSON array
  triage_config: string; // JSON
  custom_instructions: string | null;
  status: 'active' | 'paused' | 'disabled';
  created_at: string;
  updated_at: string;
}

export interface PortalTeam {
  id: string;
  name: string;
  description: string | null;
  team_type: 'client' | 'specialist' | 'cyber';
  created_at: string;
}

export interface PortalTeamMember {
  team_id: string;
  agent_id: string;
  role: 'primary' | 'specialist' | 'member';
  escalation_order: number | null;
  trigger_categories: string | null; // JSON array
}

export interface PortalEscalationRule {
  id: string;
  team_id: string;
  condition_type: 'category' | 'priority' | 'keyword' | 'timeout';
  condition_value: string;
  target_agent_id: string;
  action: 'escalate' | 'notify' | 'co-triage';
  created_at: string;
}

export interface PortalKnowledgeBase {
  id: string;
  name: string;
  scope: 'global' | 'specialist' | 'client';
  assigned_agent_id: string | null;
  description: string | null;
  created_at: string;
}

export interface PortalKBDocument {
  id: string;
  kb_id: string;
  filename: string;
  file_path: string;
  file_size: number | null;
  mime_type: string | null;
  uploaded_at: string;
}

export interface PortalActivity {
  id: number;
  agent_id: string;
  ticket_id: number | null;
  ticket_display_id: string | null;
  action_type: string;
  detail: string | null; // JSON
  client_id: number | null;
  duration_ms: number | null;
  created_at: string;
}

export interface PortalUser {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  role: 'admin' | 'operator' | 'viewer';
  created_at: string;
}

export interface PortalChatMessage {
  id: string;
  agent_id: string;
  user_id: string | null;
  direction: 'inbound' | 'outbound';
  content: string;
  created_at: string;
}

// --- Schema ---

function createPortalSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS portal_agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      display_name TEXT,
      role TEXT NOT NULL DEFAULT 'dedicated',
      client_id INTEGER,
      client_name TEXT,
      group_folder TEXT NOT NULL UNIQUE,
      specializations TEXT DEFAULT '[]',
      triage_config TEXT DEFAULT '{}',
      custom_instructions TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS portal_teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      team_type TEXT NOT NULL DEFAULT 'client',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS portal_team_members (
      team_id TEXT NOT NULL REFERENCES portal_teams(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES portal_agents(id) ON DELETE CASCADE,
      role TEXT DEFAULT 'member',
      escalation_order INTEGER,
      trigger_categories TEXT,
      PRIMARY KEY (team_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS portal_escalation_rules (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES portal_teams(id) ON DELETE CASCADE,
      condition_type TEXT NOT NULL,
      condition_value TEXT NOT NULL,
      target_agent_id TEXT NOT NULL REFERENCES portal_agents(id) ON DELETE CASCADE,
      action TEXT DEFAULT 'escalate',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS portal_knowledge_bases (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'global',
      assigned_agent_id TEXT REFERENCES portal_agents(id) ON DELETE SET NULL,
      description TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS portal_kb_documents (
      id TEXT PRIMARY KEY,
      kb_id TEXT NOT NULL REFERENCES portal_knowledge_bases(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_size INTEGER,
      mime_type TEXT,
      uploaded_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS portal_agent_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      ticket_id INTEGER,
      ticket_display_id TEXT,
      action_type TEXT NOT NULL,
      detail TEXT,
      client_id INTEGER,
      duration_ms INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_activity_agent ON portal_agent_activity(agent_id);
    CREATE INDEX IF NOT EXISTS idx_activity_created ON portal_agent_activity(created_at);

    CREATE TABLE IF NOT EXISTS portal_users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'operator',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS portal_chat_messages (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      user_id TEXT,
      direction TEXT NOT NULL DEFAULT 'inbound',
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_chat_agent ON portal_chat_messages(agent_id, created_at);
  `);
}

// --- Init ---

export function initPortalDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  createPortalSchema(db);
  logger.info('Portal database schema initialized');
}

export function getPortalDb(): Database.Database {
  return db;
}

function uuid(): string {
  return crypto.randomUUID();
}

// --- Agent CRUD ---

export function createAgent(
  agent: Omit<PortalAgent, 'id' | 'created_at' | 'updated_at'>,
): PortalAgent {
  const id = uuid();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO portal_agents (id, name, display_name, role, client_id, client_name, group_folder, specializations, triage_config, custom_instructions, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    agent.name,
    agent.display_name,
    agent.role,
    agent.client_id,
    agent.client_name,
    agent.group_folder,
    agent.specializations,
    agent.triage_config,
    agent.custom_instructions,
    agent.status,
    now,
    now,
  );
  return { ...agent, id, created_at: now, updated_at: now };
}

export function getAgent(id: string): PortalAgent | undefined {
  return db.prepare('SELECT * FROM portal_agents WHERE id = ?').get(id) as
    | PortalAgent
    | undefined;
}

export function getAllAgents(): PortalAgent[] {
  return db
    .prepare('SELECT * FROM portal_agents ORDER BY created_at DESC')
    .all() as PortalAgent[];
}

export function updateAgent(
  id: string,
  updates: Partial<
    Pick<
      PortalAgent,
      | 'name'
      | 'display_name'
      | 'role'
      | 'client_id'
      | 'client_name'
      | 'specializations'
      | 'triage_config'
      | 'custom_instructions'
      | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }
  if (fields.length === 0) return;

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  db.prepare(
    `UPDATE portal_agents SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteAgent(id: string): void {
  db.prepare('DELETE FROM portal_agents WHERE id = ?').run(id);
}

// --- Team CRUD ---

export function createTeam(
  team: Omit<PortalTeam, 'id' | 'created_at'>,
): PortalTeam {
  const id = uuid();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO portal_teams (id, name, description, team_type, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, team.name, team.description, team.team_type, now);
  return { ...team, id, created_at: now };
}

export function getTeam(id: string): PortalTeam | undefined {
  return db.prepare('SELECT * FROM portal_teams WHERE id = ?').get(id) as
    | PortalTeam
    | undefined;
}

export function getAllTeams(): PortalTeam[] {
  return db
    .prepare('SELECT * FROM portal_teams ORDER BY created_at DESC')
    .all() as PortalTeam[];
}

export function updateTeam(
  id: string,
  updates: Partial<Pick<PortalTeam, 'name' | 'description' | 'team_type'>>,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }
  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE portal_teams SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

export function deleteTeam(id: string): void {
  db.prepare('DELETE FROM portal_teams WHERE id = ?').run(id);
}

// --- Team Members ---

export function addTeamMember(member: PortalTeamMember): void {
  db.prepare(
    `INSERT OR REPLACE INTO portal_team_members (team_id, agent_id, role, escalation_order, trigger_categories)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    member.team_id,
    member.agent_id,
    member.role,
    member.escalation_order,
    member.trigger_categories,
  );
}

export function removeTeamMember(teamId: string, agentId: string): void {
  db.prepare(
    'DELETE FROM portal_team_members WHERE team_id = ? AND agent_id = ?',
  ).run(teamId, agentId);
}

export function getTeamMembers(teamId: string): (PortalTeamMember & { agent_name: string; agent_status: string })[] {
  return db
    .prepare(
      `SELECT tm.*, pa.name as agent_name, pa.status as agent_status
       FROM portal_team_members tm
       JOIN portal_agents pa ON tm.agent_id = pa.id
       WHERE tm.team_id = ?
       ORDER BY tm.escalation_order`,
    )
    .all(teamId) as (PortalTeamMember & { agent_name: string; agent_status: string })[];
}

// --- Escalation Rules ---

export function createEscalationRule(
  rule: Omit<PortalEscalationRule, 'id' | 'created_at'>,
): PortalEscalationRule {
  const id = uuid();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO portal_escalation_rules (id, team_id, condition_type, condition_value, target_agent_id, action, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, rule.team_id, rule.condition_type, rule.condition_value, rule.target_agent_id, rule.action, now);
  return { ...rule, id, created_at: now };
}

export function getEscalationRules(teamId: string): PortalEscalationRule[] {
  return db
    .prepare('SELECT * FROM portal_escalation_rules WHERE team_id = ?')
    .all(teamId) as PortalEscalationRule[];
}

export function deleteEscalationRule(id: string): void {
  db.prepare('DELETE FROM portal_escalation_rules WHERE id = ?').run(id);
}

// --- Knowledge Bases ---

export function createKnowledgeBase(
  kb: Omit<PortalKnowledgeBase, 'id' | 'created_at'>,
): PortalKnowledgeBase {
  const id = uuid();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO portal_knowledge_bases (id, name, scope, assigned_agent_id, description, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, kb.name, kb.scope, kb.assigned_agent_id, kb.description, now);
  return { ...kb, id, created_at: now };
}

export function getKnowledgeBase(id: string): PortalKnowledgeBase | undefined {
  return db
    .prepare('SELECT * FROM portal_knowledge_bases WHERE id = ?')
    .get(id) as PortalKnowledgeBase | undefined;
}

export function getAllKnowledgeBases(): PortalKnowledgeBase[] {
  return db
    .prepare('SELECT * FROM portal_knowledge_bases ORDER BY scope, name')
    .all() as PortalKnowledgeBase[];
}

export function updateKnowledgeBase(
  id: string,
  updates: Partial<Pick<PortalKnowledgeBase, 'name' | 'scope' | 'assigned_agent_id' | 'description'>>,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }
  if (fields.length === 0) return;
  values.push(id);
  db.prepare(
    `UPDATE portal_knowledge_bases SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteKnowledgeBase(id: string): void {
  db.prepare('DELETE FROM portal_knowledge_bases WHERE id = ?').run(id);
}

// --- KB Documents ---

export function addKBDocument(
  doc: Omit<PortalKBDocument, 'id' | 'uploaded_at'>,
): PortalKBDocument {
  const id = uuid();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO portal_kb_documents (id, kb_id, filename, file_path, file_size, mime_type, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, doc.kb_id, doc.filename, doc.file_path, doc.file_size, doc.mime_type, now);
  return { ...doc, id, uploaded_at: now };
}

export function getKBDocuments(kbId: string): PortalKBDocument[] {
  return db
    .prepare(
      'SELECT * FROM portal_kb_documents WHERE kb_id = ? ORDER BY uploaded_at DESC',
    )
    .all(kbId) as PortalKBDocument[];
}

export function deleteKBDocument(id: string): void {
  db.prepare('DELETE FROM portal_kb_documents WHERE id = ?').run(id);
}

// --- Activity Log ---

export function logActivity(activity: Omit<PortalActivity, 'id' | 'created_at'>): void {
  db.prepare(
    `INSERT INTO portal_agent_activity (agent_id, ticket_id, ticket_display_id, action_type, detail, client_id, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    activity.agent_id,
    activity.ticket_id,
    activity.ticket_display_id,
    activity.action_type,
    activity.detail,
    activity.client_id,
    activity.duration_ms,
  );
}

export function getActivityLog(
  filters: { agent_id?: string; limit?: number; offset?: number },
): PortalActivity[] {
  let sql = 'SELECT * FROM portal_agent_activity';
  const params: unknown[] = [];

  if (filters.agent_id) {
    sql += ' WHERE agent_id = ?';
    params.push(filters.agent_id);
  }

  sql += ' ORDER BY created_at DESC';

  if (filters.limit) {
    sql += ' LIMIT ?';
    params.push(filters.limit);
  }
  if (filters.offset) {
    sql += ' OFFSET ?';
    params.push(filters.offset);
  }

  return db.prepare(sql).all(...params) as PortalActivity[];
}

export function getRecentActivity(limit: number = 50): PortalActivity[] {
  return db
    .prepare(
      `SELECT paa.*, pa.name as agent_name
       FROM portal_agent_activity paa
       LEFT JOIN portal_agents pa ON paa.agent_id = pa.id
       ORDER BY paa.created_at DESC LIMIT ?`,
    )
    .all(limit) as PortalActivity[];
}

// --- Users ---

export function createUser(
  user: Omit<PortalUser, 'id' | 'created_at'>,
): PortalUser {
  const id = uuid();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO portal_users (id, email, name, password_hash, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, user.email, user.name, user.password_hash, user.role, now);
  return { ...user, id, created_at: now };
}

export function getUserByEmail(email: string): PortalUser | undefined {
  return db.prepare('SELECT * FROM portal_users WHERE email = ?').get(email) as
    | PortalUser
    | undefined;
}

export function getUserById(id: string): PortalUser | undefined {
  return db.prepare('SELECT * FROM portal_users WHERE id = ?').get(id) as
    | PortalUser
    | undefined;
}

export function getUserCount(): number {
  const row = db
    .prepare('SELECT COUNT(*) as count FROM portal_users')
    .get() as { count: number };
  return row.count;
}

// --- Chat Messages ---

export function storeChatMessage(msg: Omit<PortalChatMessage, 'id' | 'created_at'>): PortalChatMessage {
  const id = uuid();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO portal_chat_messages (id, agent_id, user_id, direction, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, msg.agent_id, msg.user_id, msg.direction, msg.content, now);
  return { ...msg, id, created_at: now };
}

export function getChatHistory(
  agentId: string,
  limit: number = 100,
): PortalChatMessage[] {
  return db
    .prepare(
      `SELECT * FROM (
        SELECT * FROM portal_chat_messages
        WHERE agent_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      ) ORDER BY created_at`,
    )
    .all(agentId, limit) as PortalChatMessage[];
}

// --- Dashboard Stats ---

export function getDashboardStats(): {
  total_agents: number;
  active_agents: number;
  total_teams: number;
  total_kb: number;
  recent_activities: number;
} {
  const total_agents = (
    db.prepare('SELECT COUNT(*) as c FROM portal_agents').get() as { c: number }
  ).c;
  const active_agents = (
    db
      .prepare(
        "SELECT COUNT(*) as c FROM portal_agents WHERE status = 'active'",
      )
      .get() as { c: number }
  ).c;
  const total_teams = (
    db.prepare('SELECT COUNT(*) as c FROM portal_teams').get() as { c: number }
  ).c;
  const total_kb = (
    db.prepare('SELECT COUNT(*) as c FROM portal_knowledge_bases').get() as {
      c: number;
    }
  ).c;
  const recent_activities = (
    db
      .prepare(
        "SELECT COUNT(*) as c FROM portal_agent_activity WHERE created_at > datetime('now', '-24 hours')",
      )
      .get() as { c: number }
  ).c;

  return { total_agents, active_agents, total_teams, total_kb, recent_activities };
}
