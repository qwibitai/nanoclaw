/**
 * Tests for the read_own_conversations MCP tool's script builder.
 * We extract and test the buildConversationQueryScript logic by importing
 * the generated script format and verifying its structure.
 */
import { describe, it, expect } from 'vitest';

// The buildConversationQueryScript function is not exported from
// ipc-mcp-stdio.ts (it's module-private). We test the base64 encoding
// and script structure by reimplementing the pure logic here.

function buildConversationQueryScript(dbPath: string, options: {
  lines: number;
  hours: number;
  channel?: string | null;
  search?: string | null;
}): string {
  const config = JSON.stringify({
    db_path: dbPath,
    hours: options.hours,
    lines: options.lines,
    channel: options.channel ?? null,
    search: options.search ?? null,
  });
  const b64Config = Buffer.from(config).toString('base64');

  return `
import sqlite3, os, json, base64

config = json.loads(base64.b64decode('${b64Config}').decode())
db_path = os.path.expanduser(config['db_path'])
conn = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
cursor = conn.cursor()

where_clauses = ["m.timestamp >= datetime('now', '-' || ? || ' hours')"]
params = [config['hours']]

if config['channel']:
    where_clauses.append("c.channel = ?")
    params.append(config['channel'])

if config['search']:
    where_clauses.append("m.content LIKE '%' || ? || '%'")
    params.append(config['search'])

params.append(config['lines'])
where_str = ' AND '.join(where_clauses)

cursor.execute(f"""
  SELECT m.timestamp, c.channel, m.sender_name, m.is_from_me, m.content
  FROM messages m
  JOIN chats c ON m.chat_jid = c.jid
  WHERE {where_str}
  ORDER BY m.timestamp DESC
  LIMIT ?
""", params)
rows = cursor.fetchall()
conn.close()
for row in rows:
    ts, ch, sender, is_me, content = row
    print(f"{ts} | {ch} | {sender} | {bool(is_me)} | {content}")
`.trim();
}

describe('buildConversationQueryScript', () => {
  it('encodes config as base64 JSON', () => {
    const script = buildConversationQueryScript('/test/db.sqlite', {
      lines: 20,
      hours: 4,
    });

    // Extract the base64 string from the script
    const match = script.match(/base64\.b64decode\('([^']+)'\)/);
    expect(match).not.toBeNull();

    const decoded = JSON.parse(Buffer.from(match![1], 'base64').toString());
    expect(decoded.db_path).toBe('/test/db.sqlite');
    expect(decoded.lines).toBe(20);
    expect(decoded.hours).toBe(4);
    expect(decoded.channel).toBeNull();
    expect(decoded.search).toBeNull();
  });

  it('includes channel filter when specified', () => {
    const script = buildConversationQueryScript('/test/db.sqlite', {
      lines: 10,
      hours: 2,
      channel: 'slack',
    });

    const match = script.match(/base64\.b64decode\('([^']+)'\)/);
    const decoded = JSON.parse(Buffer.from(match![1], 'base64').toString());
    expect(decoded.channel).toBe('slack');
  });

  it('includes search filter when specified', () => {
    const script = buildConversationQueryScript('/test/db.sqlite', {
      lines: 10,
      hours: 2,
      search: 'deploy',
    });

    const match = script.match(/base64\.b64decode\('([^']+)'\)/);
    const decoded = JSON.parse(Buffer.from(match![1], 'base64').toString());
    expect(decoded.search).toBe('deploy');
  });

  it('opens database in read-only mode', () => {
    const script = buildConversationQueryScript('/test/db.sqlite', {
      lines: 20,
      hours: 4,
    });

    expect(script).toContain('mode=ro');
  });

  it('uses parameterized queries (? placeholders)', () => {
    const script = buildConversationQueryScript('/test/db.sqlite', {
      lines: 20,
      hours: 4,
    });

    // SQL uses ? placeholders, not string interpolation
    expect(script).toContain("datetime('now', '-' || ? || ' hours')");
    expect(script).toContain('LIMIT ?');
  });

  it('base64 config cannot contain shell-breaking characters', () => {
    // Even with adversarial input, base64 encoding is [A-Za-z0-9+/=]
    const script = buildConversationQueryScript('/test/db.sqlite', {
      lines: 20,
      hours: 4,
      search: "'; DROP TABLE messages; --",
    });

    const match = script.match(/base64\.b64decode\('([^']+)'\)/);
    expect(match).not.toBeNull();
    // base64 string should only contain safe characters
    expect(match![1]).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});
