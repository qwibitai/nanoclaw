/**
 * MongoDB task CRUD client using mongosh CLI.
 *
 * The agent container doesn't have a native MongoDB driver installed.
 * All operations shell out to `mongosh` via child_process, matching
 * NanoClaw's tool-via-bash pattern.
 */

import { execFile } from 'node:child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskStatus =
  | 'assigned'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'escalated'
  | 'blocked';

export interface Task {
  _id: string;
  bot: string;
  title: string;
  description: string;
  priority: number;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
  deadline: string | null;
  assigned_via: 'notice' | 'slack';
  notice_id: string;
  depends_on: string[];
  outcome: string;
  lessons: string;
}

export interface CreateTaskInput {
  bot: string;
  title: string;
  description?: string;
  priority?: number;
  deadline?: string | null;
  assigned_via?: 'notice' | 'slack';
  notice_id?: string;
  depends_on?: string[];
}

export interface UpdateTaskInput {
  status?: TaskStatus;
  outcome?: string;
  lessons?: string;
  notice_id?: string;
  priority?: number;
}

export interface TaskFilter {
  status?: TaskStatus | TaskStatus[];
  bot?: string;
  assignee?: string; // alias for bot
}

export interface Comment {
  _id: string;
  task_id: string;
  author: string;
  body: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _mongoUri: string | undefined;

/** Initialise the MongoDB client with a connection URI. Call once at startup. */
export function initMongoClient(uri: string): void {
  _mongoUri = uri;
}

function getMongoUri(): string {
  const uri = _mongoUri ?? process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not configured. Call initMongoClient(uri) or set MONGODB_URI env var.');
  return uri;
}

/**
 * Run a mongosh --eval command and return parsed JSON output.
 * Uses EJSON.stringify so ObjectIds etc. come back as plain strings.
 */
export function mongosh(evalExpr: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const uri = getMongoUri();
    execFile(
      'mongosh',
      [uri, '--quiet', '--eval', evalExpr],
      { timeout: 15_000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`mongosh error: ${err.message}\n${stderr}`));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

/** Validate a string is a valid MongoDB ObjectId (24-char hex) */
export function validateObjectId(id: string): string {
  if (!/^[0-9a-fA-F]{24}$/.test(id)) {
    throw new Error(`Invalid ObjectId: ${id}`);
  }
  return id;
}

/** Validate priority is a finite number between 1 and 5 */
export function validatePriority(priority: number): number {
  const n = Number(priority);
  if (!Number.isFinite(n) || n < 1 || n > 5) {
    throw new Error(`Invalid priority: ${priority}. Must be 1-5.`);
  }
  return n;
}

/** Escape a string for embedding in a JS string literal inside mongosh eval */
function esc(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

export async function createTask(input: CreateTaskInput): Promise<Task> {
  const {
    bot,
    title,
    description = '',
    priority = 3,
    deadline = null,
    assigned_via = 'notice',
    notice_id = '',
    depends_on = [],
  } = input;

  const validatedPriority = validatePriority(priority);
  const deadlineExpr = deadline ? `new Date('${esc(deadline)}')` : 'null';
  const depsArray = depends_on.map((d) => `'${esc(d)}'`).join(',');

  const expr = `
    const r = db.tasks.insertOne({
      bot: '${esc(bot)}',
      title: '${esc(title)}',
      description: '${esc(description)}',
      priority: ${validatedPriority},
      status: 'assigned',
      created_at: new Date(),
      updated_at: new Date(),
      deadline: ${deadlineExpr},
      assigned_via: '${esc(assigned_via)}',
      notice_id: '${esc(notice_id)}',
      depends_on: [${depsArray}],
      outcome: '',
      lessons: ''
    });
    const doc = db.tasks.findOne({ _id: r.insertedId });
    print(EJSON.stringify(doc));
  `;

  const raw = await mongosh(expr);
  return parseTask(raw);
}

export async function getTask(taskId: string): Promise<Task | null> {
  const validId = validateObjectId(taskId);
  const expr = `
    const doc = db.tasks.findOne({ _id: ObjectId('${validId}') });
    print(doc ? EJSON.stringify(doc) : 'null');
  `;
  const raw = await mongosh(expr);
  if (raw === 'null' || raw === '') return null;
  return parseTask(raw);
}

export async function listTasks(filter: TaskFilter = {}): Promise<Task[]> {
  const conditions: string[] = [];

  // bot or assignee (alias)
  const botValue = filter.bot ?? filter.assignee;
  if (botValue) {
    conditions.push(`bot: '${esc(botValue)}'`);
  }

  if (filter.status) {
    if (Array.isArray(filter.status)) {
      const arr = filter.status.map((s) => `'${esc(s)}'`).join(',');
      conditions.push(`status: { $in: [${arr}] }`);
    } else {
      conditions.push(`status: '${esc(filter.status)}'`);
    }
  }

  const query = conditions.length ? `{ ${conditions.join(', ')} }` : '{}';

  const expr = `
    const docs = db.tasks.find(${query}).sort({ priority: 1, created_at: 1 }).toArray();
    print(EJSON.stringify(docs));
  `;
  const raw = await mongosh(expr);
  if (raw === '[]' || raw === '') return [];
  return parseTasks(raw);
}

export async function updateTask(
  taskId: string,
  updates: UpdateTaskInput,
): Promise<Task | null> {
  const sets: string[] = ['updated_at: new Date()'];

  if (updates.status !== undefined) sets.push(`status: '${esc(updates.status)}'`);
  if (updates.outcome !== undefined) sets.push(`outcome: '${esc(updates.outcome)}'`);
  if (updates.lessons !== undefined) sets.push(`lessons: '${esc(updates.lessons)}'`);
  if (updates.notice_id !== undefined) sets.push(`notice_id: '${esc(updates.notice_id)}'`);
  if (updates.priority !== undefined) sets.push(`priority: ${validatePriority(updates.priority)}`);

  const validId = validateObjectId(taskId);
  const expr = `
    db.tasks.updateOne(
      { _id: ObjectId('${validId}') },
      { $set: { ${sets.join(', ')} } }
    );
    const doc = db.tasks.findOne({ _id: ObjectId('${validId}') });
    print(doc ? EJSON.stringify(doc) : 'null');
  `;
  const raw = await mongosh(expr);
  if (raw === 'null' || raw === '') return null;
  return parseTask(raw);
}

export async function addComment(
  taskId: string,
  author: string,
  body: string,
): Promise<Comment> {
  const validId = validateObjectId(taskId);
  const expr = `
    const r = db.task_comments.insertOne({
      task_id: '${validId}',
      author: '${esc(author)}',
      body: '${esc(body)}',
      created_at: new Date()
    });
    const doc = db.task_comments.findOne({ _id: r.insertedId });
    print(EJSON.stringify(doc));
  `;
  const raw = await mongosh(expr);
  return parseComment(raw);
}

export async function listComments(taskId: string): Promise<Comment[]> {
  const validId = validateObjectId(taskId);
  const expr = `
    const docs = db.task_comments.find({ task_id: '${validId}' }).sort({ created_at: 1 }).toArray();
    print(EJSON.stringify(docs));
  `;
  const raw = await mongosh(expr);
  if (raw === '[]' || raw === '') return [];
  return parseComments(raw);
}

// ---------------------------------------------------------------------------
// Parsing helpers — normalise EJSON into plain objects
// ---------------------------------------------------------------------------

function normaliseDoc(doc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (v && typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      if ('$oid' in obj) {
        out[k] = obj.$oid as string;
      } else if ('$date' in obj) {
        const dateVal = obj.$date;
        if (typeof dateVal === 'object' && dateVal !== null && '$numberLong' in (dateVal as Record<string, unknown>)) {
          out[k] = new Date(Number((dateVal as Record<string, unknown>).$numberLong)).toISOString();
        } else {
          out[k] = typeof dateVal === 'string' ? dateVal : String(dateVal);
        }
      } else if (Array.isArray(v)) {
        out[k] = v;
      } else {
        out[k] = normaliseDoc(obj);
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

function parseTask(raw: string): Task {
  const doc = normaliseDoc(JSON.parse(raw));
  return doc as unknown as Task;
}

function parseTasks(raw: string): Task[] {
  const docs = JSON.parse(raw) as Record<string, unknown>[];
  return docs.map((d) => normaliseDoc(d) as unknown as Task);
}

function parseComment(raw: string): Comment {
  return normaliseDoc(JSON.parse(raw)) as unknown as Comment;
}

function parseComments(raw: string): Comment[] {
  const docs = JSON.parse(raw) as Record<string, unknown>[];
  return docs.map((d) => normaliseDoc(d) as unknown as Comment);
}
