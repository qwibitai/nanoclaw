/**
 * Observability metrics — query functions for operational status.
 * All functions are pure reads.
 */
import { getDb } from './db.js';

export interface TaskCountByState {
  state: string;
  count: number;
}

export interface TaskCountByProduct {
  product_id: string | null;
  product_name: string | null;
  count: number;
}

export interface ExtCallCountByProvider {
  provider: string;
  count: number;
}

export interface WipLoad {
  group: string;
  doing_count: number;
}

export interface FailedDispatch {
  task_id: string;
  dispatch_key: string;
  from_state: string;
  to_state: string;
  group_jid: string;
  created_at: string;
}

export interface L3Call {
  request_id: string;
  group_folder: string;
  provider: string;
  action: string;
  status: string;
  created_at: string;
}

export function countTasksByState(): TaskCountByState[] {
  const db = getDb();
  return db
    .prepare('SELECT state, COUNT(*) as count FROM gov_tasks GROUP BY state ORDER BY state')
    .all() as TaskCountByState[];
}

export function countTasksByProduct(): TaskCountByProduct[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT gt.product_id, p.name as product_name, COUNT(*) as count
       FROM gov_tasks gt
       LEFT JOIN products p ON gt.product_id = p.id
       GROUP BY gt.product_id
       ORDER BY count DESC`,
    )
    .all() as TaskCountByProduct[];
}

export function countExtCallsByProvider(): ExtCallCountByProvider[] {
  const db = getDb();
  return db
    .prepare('SELECT provider, COUNT(*) as count FROM ext_calls GROUP BY provider ORDER BY count DESC')
    .all() as ExtCallCountByProvider[];
}

export function getWipLoad(): WipLoad[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT assigned_group as "group", COUNT(*) as doing_count
       FROM gov_tasks
       WHERE state = 'DOING' AND assigned_group IS NOT NULL
       GROUP BY assigned_group
       ORDER BY doing_count DESC`,
    )
    .all() as WipLoad[];
}

export function getFailedDispatches(limit = 20): FailedDispatch[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT task_id, dispatch_key, from_state, to_state, group_jid, created_at
       FROM gov_dispatches
       WHERE status = 'FAILED'
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(limit) as FailedDispatch[];
}

export function getL3CallsLast24h(): L3Call[] {
  const db = getDb();
  const cutoff = new Date(Date.now() - 86_400_000).toISOString();
  return db
    .prepare(
      `SELECT request_id, group_folder, provider, action, status, created_at
       FROM ext_calls
       WHERE access_level = 3 AND created_at > ?
       ORDER BY created_at DESC`,
    )
    .all(cutoff) as L3Call[];
}
