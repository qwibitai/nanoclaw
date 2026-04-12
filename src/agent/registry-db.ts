import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { customAlphabet } from 'nanoid';

import {
  normalizeJson,
  serializeMountAllowlist,
  type SerializableAgentSettings,
} from './config.js';
import type { MountAllowlist } from '../types.js';
import type { McpServerConfig } from '../api/options.js';

const AGENT_REGISTRY_DB = 'agentlite.db';
const AGENT_REGISTRY_DIR = 'store';
const AGENT_ID_LENGTH = 8;
const generateAgentId = customAlphabet(
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  AGENT_ID_LENGTH,
);

export interface AgentRegistryRecord extends SerializableAgentSettings {
  readonly agentId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface AgentRegistryRow {
  name: string;
  agent_id: string;
  workdir: string;
  assistant_name: string;
  mount_allowlist_json: string | null;
  instructions: string | null;
  skills_sources_json: string | null;
  mcp_servers_json: string | null;
  created_at: string;
  updated_at: string;
}

function addColumnIfMissing(
  database: Database.Database,
  table: string,
  column: string,
  type: string,
): void {
  const cols = database.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      name TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL UNIQUE,
      workdir TEXT NOT NULL,
      assistant_name TEXT NOT NULL,
      mount_allowlist_json TEXT,
      instructions TEXT,
      skills_sources_json TEXT,
      mcp_servers_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  // Migrate existing databases that lack the new columns
  addColumnIfMissing(database, 'agents', 'instructions', 'TEXT');
  addColumnIfMissing(database, 'agents', 'skills_sources_json', 'TEXT');
  addColumnIfMissing(database, 'agents', 'mcp_servers_json', 'TEXT');
}

function parseMountAllowlist(raw: string | null): MountAllowlist | null {
  return raw ? (JSON.parse(raw) as MountAllowlist) : null;
}

function mapRow(
  row: AgentRegistryRow | undefined,
): AgentRegistryRecord | undefined {
  if (!row) return undefined;
  return {
    agentId: row.agent_id,
    agentName: row.name,
    workDir: row.workdir,
    assistantName: row.assistant_name,
    mountAllowlist: parseMountAllowlist(row.mount_allowlist_json),
    instructions: row.instructions ?? null,
    skillsSources: row.skills_sources_json
      ? (JSON.parse(row.skills_sources_json) as string[])
      : null,
    mcpServers: row.mcp_servers_json
      ? (JSON.parse(row.mcp_servers_json) as Record<string, McpServerConfig>)
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isUniqueConstraint(err: unknown, columnName: string): boolean {
  return (
    err instanceof Error &&
    err.message.includes('UNIQUE constraint failed') &&
    err.message.includes(columnName)
  );
}

export function getAgentRegistryDbPath(workdir: string): string {
  return path.join(
    path.resolve(workdir),
    AGENT_REGISTRY_DIR,
    AGENT_REGISTRY_DB,
  );
}

export class AgentRegistryDb {
  constructor(private readonly db: Database.Database) {}

  getAgent(name: string): AgentRegistryRecord | undefined {
    return mapRow(
      this.db.prepare('SELECT * FROM agents WHERE name = ?').get(name) as
        | AgentRegistryRow
        | undefined,
    );
  }

  listAgents(): AgentRegistryRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM agents ORDER BY name')
      .all() as AgentRegistryRow[];
    return rows.map((row) => mapRow(row)!);
  }

  createAgent(settings: SerializableAgentSettings): AgentRegistryRecord {
    const now = new Date().toISOString();
    const mountAllowlistJson = serializeMountAllowlist(settings.mountAllowlist);
    const skillsSourcesJson = settings.skillsSources
      ? JSON.stringify(settings.skillsSources)
      : null;
    const mcpServersJson = settings.mcpServers
      ? JSON.stringify(normalizeJson(settings.mcpServers))
      : null;

    while (true) {
      const agentId = generateAgentId();
      try {
        this.db
          .prepare(
            `
              INSERT INTO agents (
                name,
                agent_id,
                workdir,
                assistant_name,
                mount_allowlist_json,
                instructions,
                skills_sources_json,
                mcp_servers_json,
                created_at,
                updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
          )
          .run(
            settings.agentName,
            agentId,
            settings.workDir,
            settings.assistantName,
            mountAllowlistJson,
            settings.instructions,
            skillsSourcesJson,
            mcpServersJson,
            now,
            now,
          );
        return {
          ...settings,
          agentId,
          createdAt: now,
          updatedAt: now,
        };
      } catch (err) {
        if (isUniqueConstraint(err, 'agents.agent_id')) {
          continue;
        }
        throw err;
      }
    }
  }

  deleteAgent(name: string): void {
    this.db.prepare('DELETE FROM agents WHERE name = ?').run(name);
  }

  close(): void {
    this.db.close();
  }
}

export function initAgentRegistryDb(workdir: string): AgentRegistryDb {
  const dbPath = getAgentRegistryDbPath(workdir);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const database = new Database(dbPath);
  createSchema(database);
  return new AgentRegistryDb(database);
}
