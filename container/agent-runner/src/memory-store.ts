/**
 * LanceDB Storage Layer with Multi-Scope Support
 */

import type * as LanceDB from "@lancedb/lancedb";
import { clampInt } from "./memory-utils.js";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  accessSync,
  constants,
  mkdirSync,
  realpathSync,
  lstatSync,
} from "node:fs";
import { dirname } from "node:path";

// ============================================================================
// Types
// ============================================================================

export interface MemoryEntry {
  id: string;
  text: string;
  vector: number[];
  category: "preference" | "fact" | "decision" | "entity" | "other" | "reflection";
  scope: string;
  importance: number;
  timestamp: number;
  metadata?: string; // JSON string for extensible metadata
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
}

export interface StoreConfig {
  dbPath: string;
  vectorDim: number;
  /** API key for LanceDB Cloud (required when dbPath starts with "db://") */
  apiKey?: string;
}

// ============================================================================
// LanceDB Dynamic Import
// ============================================================================

let lancedbImportPromise: Promise<typeof import("@lancedb/lancedb")> | null =
  null;

export const loadLanceDB = async (): Promise<
  typeof import("@lancedb/lancedb")
> => {
  if (!lancedbImportPromise) {
    lancedbImportPromise = import("@lancedb/lancedb");
  }
  try {
    return await lancedbImportPromise;
  } catch (err) {
    throw new Error(
      `memory-lancedb-pro: failed to load LanceDB. ${String(err)}`,
      { cause: err },
    );
  }
};

// ============================================================================
// Utility Functions
// ============================================================================

const SCOPE_PATTERN = /^[a-zA-Z0-9_.:-]+$/;
function validateScope(scope: string): string {
  if (!SCOPE_PATTERN.test(scope)) {
    throw new Error(`Invalid scope value: '${scope}'. Scope must match ${SCOPE_PATTERN}`);
  }
  return scope;
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "''");
}

// ============================================================================
// Storage Path Validation
// ============================================================================

/**
 * Validate and prepare the storage directory before LanceDB connection.
 * Resolves symlinks, creates missing directories, and checks write permissions.
 * Returns the resolved absolute path on success, or throws a descriptive error.
 */
export function validateStoragePath(dbPath: string): string {
  let resolvedPath = dbPath;

  // Resolve symlinks (including dangling symlinks)
  try {
    const stats = lstatSync(dbPath);
    if (stats.isSymbolicLink()) {
      try {
        resolvedPath = realpathSync(dbPath);
      } catch (err: any) {
        throw new Error(
          `dbPath "${dbPath}" is a symlink whose target does not exist.\n` +
          `  Fix: Create the target directory, or update the symlink to point to a valid path.\n` +
          `  Details: ${err.code || ""} ${err.message}`,
        );
      }
    }
  } catch (err: any) {
    // Missing path is OK (it will be created below)
    if (err?.code === "ENOENT") {
      // no-op
    } else if (
      typeof err?.message === "string" &&
      err.message.includes("symlink whose target does not exist")
    ) {
      throw err;
    } else {
      // Other lstat failures — continue with original path
    }
  }

  // Create directory if it doesn't exist
  if (!existsSync(resolvedPath)) {
    try {
      mkdirSync(resolvedPath, { recursive: true });
    } catch (err: any) {
      throw new Error(
        `Failed to create dbPath directory "${resolvedPath}".\n` +
        `  Fix: Ensure the parent directory "${dirname(resolvedPath)}" exists and is writable,\n` +
        `       or create it manually: mkdir -p "${resolvedPath}"\n` +
        `  Details: ${err.code || ""} ${err.message}`,
      );
    }
  }

  // Check write permissions
  try {
    accessSync(resolvedPath, constants.W_OK);
  } catch (err: any) {
    throw new Error(
      `dbPath directory "${resolvedPath}" is not writable.\n` +
      `  Fix: Check permissions with: ls -la "${dirname(resolvedPath)}"\n` +
      `       Or grant write access: chmod u+w "${resolvedPath}"\n` +
      `  Details: ${err.code || ""} ${err.message}`,
    );
  }

  return resolvedPath;
}

// ============================================================================
// Memory Store
// ============================================================================

const TABLE_NAME = "memories";

export class MemoryStore {
  private db: LanceDB.Connection | null = null;
  private table: LanceDB.Table | null = null;
  private initPromise: Promise<void> | null = null;
  private ftsSupported = false;
  private ftsIndexCreated = false;
  private lastFtsError: string | null = null;

  constructor(private readonly config: StoreConfig) { }

  get dbPath(): string {
    return this.config.dbPath;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.table) {
      return;
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.doInitialize().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    const lancedb = await loadLanceDB();

    let db: LanceDB.Connection;
    try {
      db = await lancedb.connect(this.config.dbPath, this.config.apiKey ? { apiKey: this.config.apiKey } : undefined);
    } catch (err: any) {
      const code = err.code || "";
      const message = err.message || String(err);
      throw new Error(
        `Failed to open LanceDB at "${this.config.dbPath}": ${code} ${message}\n` +
        `  Fix: Verify the path exists and is writable. Check parent directory permissions.`,
      );
    }

    let table: LanceDB.Table;

    // Idempotent table init: try openTable first, create only if missing,
    // and handle the race where tableNames() misses an existing table but
    // createTable then sees it (LanceDB eventual consistency).
    try {
      table = await db.openTable(TABLE_NAME);

      // Check if existing data has scope column (backward compatibility)
      try {
        const sample = await table.query().limit(1).toArray();
        if (sample.length > 0 && !("scope" in sample[0])) {
          throw new Error(
            `Existing LanceDB table at "${this.config.dbPath}" uses old schema without "scope" column.\n` +
            `  Fix: Re-embed your memories using: node scripts/migrate-memories.mjs <backup.jsonl> "${this.config.dbPath}"\n` +
            `       Or delete the table directory and let it be recreated on first store.`,
          );
        }
      } catch (err: any) {
        // Re-throw schema migration errors, only swallow probe failures
        if (err?.message?.includes('old schema')) throw err;
        console.warn("Could not check table schema:", err instanceof Error ? err.message : String(err));
      }
    } catch (_openErr) {
      // Table doesn't exist yet — create it
      const schemaEntry: MemoryEntry = {
        id: "__schema__",
        text: "",
        vector: Array.from({ length: this.config.vectorDim }).fill(
          0,
        ) as number[],
        category: "other",
        scope: "global",
        importance: 0,
        timestamp: 0,
        metadata: "{}",
      };

      try {
        table = await db.createTable(TABLE_NAME, [schemaEntry as unknown as Record<string, unknown>]);
        await table.delete('id = "__schema__"');
      } catch (createErr) {
        // Race: another caller (or eventual consistency) created the table
        // between our failed openTable and this createTable — just open it.
        if (String(createErr).includes("already exists")) {
          table = await db.openTable(TABLE_NAME);
        } else {
          throw createErr;
        }
      }
    }

    // Validate vector dimensions
    // Note: LanceDB returns Arrow Vector objects, not plain JS arrays.
    // Array.isArray() returns false for Arrow Vectors, so use .length instead.
    const sample = await table.query().limit(1).toArray();
    if (sample.length > 0 && sample[0]?.vector?.length) {
      const existingDim = sample[0].vector.length;
      if (existingDim !== this.config.vectorDim) {
        throw new Error(
          `Vector dimension mismatch: table=${existingDim}, config=${this.config.vectorDim}. Create a new table/dbPath or set matching embedding.dimensions.`,
        );
      }
    }

    // Detect FTS capability via runtime probe (reuse already-loaded module)
    try {
      this.ftsSupported = typeof (lancedb as any).Index?.fts === "function";
    } catch {
      this.ftsSupported = false;
    }

    // Create FTS index for BM25 search (graceful fallback if unavailable)
    if (this.ftsSupported) {
      try {
        await this.createFtsIndex(table);
        this.ftsIndexCreated = true;
        this.lastFtsError = null;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(
          "Failed to create FTS index, falling back to vector-only search:",
          errMsg,
        );
        this.ftsIndexCreated = false;
        this.lastFtsError = errMsg;
      }
    } else {
      this.ftsIndexCreated = false;
      this.lastFtsError = "LanceDB version does not support FTS";
    }

    this.db = db;
    this.table = table;
  }

  private async createFtsIndex(table: LanceDB.Table, force = false): Promise<void> {
    try {
      // Check if FTS index already exists
      const indices = await table.listIndices();
      const hasFtsIndex = indices?.some(
        (idx: any) => idx.indexType === "FTS" || idx.columns?.includes("text"),
      );

      if (!hasFtsIndex || force) {
        // LanceDB @lancedb/lancedb >=0.26: use Index.fts() config
        const lancedb = await loadLanceDB();
        await table.createIndex("text", {
          config: (lancedb as any).Index.fts(),
        });
      }
    } catch (err) {
      throw new Error(
        `FTS index creation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async store(
    entry: Omit<MemoryEntry, "id" | "timestamp">,
  ): Promise<MemoryEntry> {
    await this.ensureInitialized();

    const fullEntry: MemoryEntry = {
      ...entry,
      id: randomUUID(),
      timestamp: Date.now(),
      metadata: entry.metadata || "{}",
    };

    try {
      await this.table!.add([fullEntry as unknown as Record<string, unknown>]);
    } catch (err: any) {
      const code = err.code || "";
      const message = err.message || String(err);
      throw new Error(
        `Failed to store memory in "${this.config.dbPath}": ${code} ${message}`,
      );
    }
    return fullEntry;
  }

  /**
   * Import a pre-built entry while preserving its id/timestamp.
   * Used for re-embedding / migration / A/B testing across embedding models.
   * Intentionally separate from `store()` to keep normal writes simple.
   */
  async importEntry(entry: MemoryEntry): Promise<MemoryEntry> {
    await this.ensureInitialized();

    if (!entry.id || typeof entry.id !== "string") {
      throw new Error("importEntry requires a stable id");
    }

    const vector = entry.vector || [];
    if (!Array.isArray(vector) || vector.length !== this.config.vectorDim) {
      throw new Error(
        `Vector dimension mismatch: expected ${this.config.vectorDim}, got ${Array.isArray(vector) ? vector.length : "non-array"}`,
      );
    }

    const full: MemoryEntry = {
      ...entry,
      scope: entry.scope || "global",
      importance: Number.isFinite(entry.importance) ? entry.importance : 0.7,
      timestamp: Number.isFinite(entry.timestamp)
        ? entry.timestamp
        : Date.now(),
      metadata: entry.metadata || "{}",
    };

    await this.table!.add([full as unknown as Record<string, unknown>]);
    return full;
  }

  async hasId(id: string): Promise<boolean> {
    await this.ensureInitialized();
    const safeId = escapeSqlLiteral(id);
    const res = await this.table!.query()
      .select(["id"])
      .where(`id = '${safeId}'`)
      .limit(1)
      .toArray();
    return res.length > 0;
  }

  /**
   * Read a single memory entry by exact ID without any mutation.
   * Unlike update(id, {}), this performs a pure read (no delete+add cycle).
   */
  async getById(id: string): Promise<MemoryEntry | null> {
    await this.ensureInitialized();
    const safeId = escapeSqlLiteral(id);
    const rows = await this.table!.query()
      .where(`id = '${safeId}'`)
      .limit(1)
      .toArray();
    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      id: row.id as string,
      text: row.text as string,
      vector: Array.from(row.vector as Iterable<number>),
      category: row.category as MemoryEntry["category"],
      scope: (row.scope as string | undefined) ?? "global",
      importance: Number(row.importance),
      timestamp: Number(row.timestamp),
      metadata: (row.metadata as string) || "{}",
    };
  }

  async vectorSearch(
    vector: number[],
    limit = 5,
    minScore = 0.3,
    scopeFilter?: string[],
  ): Promise<MemorySearchResult[]> {
    await this.ensureInitialized();

    const safeLimit = clampInt(limit, 1, 20);
    const fetchLimit = Math.min(safeLimit * 10, 200); // Over-fetch for scope filtering

    let query = this.table!.vectorSearch(vector).distanceType('cosine').limit(fetchLimit);

    // Apply scope filter if provided
    if (scopeFilter && scopeFilter.length > 0) {
      const scopeConditions = scopeFilter
        .map((scope) => `scope = '${escapeSqlLiteral(validateScope(scope))}'`)
        .join(" OR ");
      query = query.where(`(${scopeConditions}) OR scope IS NULL`); // NULL for backward compatibility
    }

    const results = await query.toArray();
    const mapped: MemorySearchResult[] = [];

    for (const row of results) {
      const distance = Number(row._distance ?? 0);
      const score = 1 / (1 + distance);

      if (score < minScore) continue;

      const rowScope = (row.scope as string | undefined) ?? "global";

      // Double-check scope filter in application layer
      if (
        scopeFilter &&
        scopeFilter.length > 0 &&
        !scopeFilter.includes(rowScope)
      ) {
        continue;
      }

      mapped.push({
        entry: {
          id: row.id as string,
          text: row.text as string,
          vector: row.vector as number[],
          category: row.category as MemoryEntry["category"],
          scope: rowScope,
          importance: Number(row.importance),
          timestamp: Number(row.timestamp),
          metadata: (row.metadata as string) || "{}",
        },
        score,
      });

      if (mapped.length >= safeLimit) break;
    }

    return mapped;
  }

  async bm25Search(
    query: string,
    limit = 5,
    scopeFilter?: string[],
  ): Promise<MemorySearchResult[]> {
    await this.ensureInitialized();

    if (!this.ftsIndexCreated) {
      return []; // Fallback to vector-only if FTS unavailable
    }

    const safeLimit = clampInt(limit, 1, 20);

    try {
      // Use FTS query type explicitly
      let searchQuery = this.table!.search(query, "fts").limit(safeLimit);

      // Apply scope filter if provided
      if (scopeFilter && scopeFilter.length > 0) {
        const scopeConditions = scopeFilter
          .map((scope) => `scope = '${escapeSqlLiteral(validateScope(scope))}'`)
          .join(" OR ");
        searchQuery = searchQuery.where(
          `(${scopeConditions}) OR scope IS NULL`,
        );
      }

      const results = await searchQuery.toArray();
      const mapped: MemorySearchResult[] = [];

      for (const row of results) {
        const rowScope = (row.scope as string | undefined) ?? "global";

        // Double-check scope filter in application layer
        if (
          scopeFilter &&
          scopeFilter.length > 0 &&
          !scopeFilter.includes(rowScope)
        ) {
          continue;
        }

        // LanceDB FTS _score is raw BM25 (unbounded). Normalize with sigmoid.
        // LanceDB may return BigInt for numeric columns; coerce safely.
        // Map: rawScore=0 → 0 (no match), rawScore>0 → sigmoid in (0.5, 1.0)
        // The divisor (BM25_SIGMOID_SCALE=5) controls sigmoid spread: higher = more
        // gradual mapping. At 5, a raw BM25 score of ~5 maps to ~0.73; a score of
        // ~15 maps to ~0.95. This keeps typical BM25 scores in a useful 0.5–0.95 range.
        const BM25_SIGMOID_SCALE = 5;
        const rawScore = row._score != null ? Number(row._score) : 0;
        const normalizedScore =
          rawScore > 0 ? 1 / (1 + Math.exp(-rawScore / BM25_SIGMOID_SCALE)) : 0;

        mapped.push({
          entry: {
            id: row.id as string,
            text: row.text as string,
            vector: row.vector as number[],
            category: row.category as MemoryEntry["category"],
            scope: rowScope,
            importance: Number(row.importance),
            timestamp: Number(row.timestamp),
            metadata: (row.metadata as string) || "{}",
          },
          score: normalizedScore,
        });
      }

      return mapped;
    } catch (err) {
      console.warn("BM25 search failed, falling back to empty results:", err);
      return [];
    }
  }

  async delete(id: string, scopeFilter?: string[]): Promise<boolean> {
    await this.ensureInitialized();

    // Support both full UUID and short prefix (8+ hex chars)
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const prefixRegex = /^[0-9a-f]{8,}$/i;
    const isFullId = uuidRegex.test(id);
    const isPrefix = !isFullId && prefixRegex.test(id);

    if (!isFullId && !isPrefix) {
      throw new Error(`Invalid memory ID format: ${id}`);
    }

    let candidates: any[];
    // Build scope WHERE clause for DB-level filtering
    let scopeWhere = '';
    if (scopeFilter && scopeFilter.length > 0) {
      const scopeConditions = scopeFilter
        .map((s) => `scope = '${escapeSqlLiteral(validateScope(s))}'`)
        .join(" OR ");
      scopeWhere = `((${scopeConditions}) OR scope IS NULL)`;
    }
    if (isFullId) {
      let q = this.table!.query()
        .where(`id = '${escapeSqlLiteral(id)}'`);
      if (scopeWhere) q = q.where(scopeWhere);
      candidates = await q.limit(1).toArray();
    } else {
      // Prefix match: fetch candidates with scope filter at DB level
      let q = this.table!.query().select(["id", "scope"]);
      if (scopeWhere) q = q.where(scopeWhere);
      const all = await q.limit(1000).toArray();
      candidates = all.filter((r: any) => (r.id as string).startsWith(id));
      if (candidates.length > 1) {
        throw new Error(
          `Ambiguous prefix "${id}" matches ${candidates.length} memories. Use a longer prefix or full ID.`,
        );
      }
    }
    if (candidates.length === 0) {
      return false;
    }

    const resolvedId = candidates[0].id as string;
    const rowScope = (candidates[0].scope as string | undefined) ?? "global";

    // Check scope permissions
    if (
      scopeFilter &&
      scopeFilter.length > 0 &&
      !scopeFilter.includes(rowScope)
    ) {
      throw new Error(`Memory ${resolvedId} is outside accessible scopes`);
    }

    await this.table!.delete(`id = '${escapeSqlLiteral(resolvedId)}'`);
    return true;
  }

  async list(
    scopeFilter?: string[],
    category?: string,
    limit = 20,
    offset = 0,
  ): Promise<MemoryEntry[]> {
    await this.ensureInitialized();

    let query = this.table!.query();

    // Build where conditions
    const conditions: string[] = [];

    if (scopeFilter && scopeFilter.length > 0) {
      const scopeConditions = scopeFilter
        .map((scope) => `scope = '${escapeSqlLiteral(validateScope(scope))}'`)
        .join(" OR ");
      conditions.push(`((${scopeConditions}) OR scope IS NULL)`);
    }

    if (category) {
      conditions.push(`category = '${escapeSqlLiteral(category)}'`);
    }

    if (conditions.length > 0) {
      query = query.where(conditions.join(" AND "));
    }

    // Over-fetch to allow app-layer sorting, but cap to avoid loading entire table.
    // LanceDB doesn't support ORDER BY, so we fetch offset+limit rows and sort locally.
    const fetchLimit = Math.min(offset + limit, 1000);
    const results = await query
      .select([
        "id",
        "text",
        "category",
        "scope",
        "importance",
        "timestamp",
        "metadata",
      ])
      .limit(fetchLimit)
      .toArray();

    return results
      .map(
        (row): MemoryEntry => ({
          id: row.id as string,
          text: row.text as string,
          vector: [], // Don't include vectors in list results for performance
          category: row.category as MemoryEntry["category"],
          scope: (row.scope as string | undefined) ?? "global",
          importance: Number(row.importance),
          timestamp: Number(row.timestamp),
          metadata: (row.metadata as string) || "{}",
        }),
      )
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(offset, offset + limit);
  }

  async stats(scopeFilter?: string[]): Promise<{
    totalCount: number;
    scopeCounts: Record<string, number>;
    categoryCounts: Record<string, number>;
  }> {
    await this.ensureInitialized();

    let query = this.table!.query();

    if (scopeFilter && scopeFilter.length > 0) {
      const scopeConditions = scopeFilter
        .map((scope) => `scope = '${escapeSqlLiteral(validateScope(scope))}'`)
        .join(" OR ");
      query = query.where(`((${scopeConditions}) OR scope IS NULL)`);
    }

    // Scope/category breakdowns are capped at 10K rows for OOM safety;
    // if the table exceeds 10K rows, breakdowns will be approximate.
    const results = await query.select(["scope", "category"]).limit(10_000).toArray();

    // For unfiltered queries, use countRows() to get the exact total even
    // beyond the 10K cap. For filtered queries, results.length is our best
    // approximation (countRows() doesn't accept filters).
    let totalCount = results.length;
    if (!scopeFilter || scopeFilter.length === 0) {
      try {
        if (this.table && typeof (this.table as any).countRows === 'function') {
          totalCount = await (this.table as any).countRows();
        }
      } catch { /* fallback to results.length */ }
    }

    const scopeCounts: Record<string, number> = {};
    const categoryCounts: Record<string, number> = {};

    for (const row of results) {
      const scope = (row.scope as string | undefined) ?? "global";
      const category = row.category as string;

      scopeCounts[scope] = (scopeCounts[scope] || 0) + 1;
      categoryCounts[category] = (categoryCounts[category] || 0) + 1;
    }

    return {
      totalCount,
      scopeCounts,
      categoryCounts,
    };
  }

  async update(
    id: string,
    updates: {
      text?: string;
      vector?: number[];
      importance?: number;
      category?: MemoryEntry["category"];
      metadata?: string;
    },
    scopeFilter?: string[],
  ): Promise<MemoryEntry | null> {
    await this.ensureInitialized();

    // Support both full UUID and short prefix (8+ hex chars), same as delete()
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const prefixRegex = /^[0-9a-f]{8,}$/i;
    const isFullId = uuidRegex.test(id);
    const isPrefix = !isFullId && prefixRegex.test(id);

    if (!isFullId && !isPrefix) {
      throw new Error(`Invalid memory ID format: ${id}`);
    }

    let rows: any[];
    const allColumns = ["id", "text", "vector", "category", "scope", "importance", "timestamp", "metadata"];
    // Build scope WHERE clause for DB-level filtering
    let scopeWhere = '';
    if (scopeFilter && scopeFilter.length > 0) {
      const scopeConditions = scopeFilter
        .map((s) => `scope = '${escapeSqlLiteral(validateScope(s))}'`)
        .join(" OR ");
      scopeWhere = `((${scopeConditions}) OR scope IS NULL)`;
    }
    if (isFullId) {
      const safeId = escapeSqlLiteral(id);
      let q = this.table!.query()
        .select(allColumns)
        .where(`id = '${safeId}'`);
      if (scopeWhere) q = q.where(scopeWhere);
      rows = await q.limit(1).toArray();
    } else {
      // Prefix match with scope filter at DB level
      let q = this.table!.query().select(allColumns);
      if (scopeWhere) q = q.where(scopeWhere);
      const all = await q.limit(1000).toArray();
      rows = all.filter((r: any) => (r.id as string).startsWith(id));
      if (rows.length > 1) {
        throw new Error(
          `Ambiguous prefix "${id}" matches ${rows.length} memories. Use a longer prefix or full ID.`,
        );
      }
    }

    if (rows.length === 0) return null;

    const row = rows[0];
    const rowScope = (row.scope as string | undefined) ?? "global";

    // Check scope permissions
    if (
      scopeFilter &&
      scopeFilter.length > 0 &&
      !scopeFilter.includes(rowScope)
    ) {
      throw new Error(`Memory ${id} is outside accessible scopes`);
    }

    // Build updated entry, preserving original timestamp
    const updated: MemoryEntry = {
      id: row.id as string,
      text: updates.text ?? (row.text as string),
      vector: updates.vector ?? Array.from(row.vector as Iterable<number>),
      category: updates.category ?? (row.category as MemoryEntry["category"]),
      scope: rowScope,
      importance: updates.importance ?? Number(row.importance),
      timestamp: Date.now(), // bump timestamp so updated entries benefit from recency boost
      metadata: updates.metadata ?? ((row.metadata as string) || "{}"),
    };

    // LanceDB doesn't support in-place update; delete first, then add.
    // delete-then-add avoids a window where both old and new rows are visible
    // to parallel reads. If we crash between delete and add, data is lost for
    // this entry — acceptable for a memory system vs. returning duplicates.
    const resolvedId = escapeSqlLiteral(row.id as string);
    await this.table!.delete(`id = '${resolvedId}'`);
    await this.table!.add([updated as unknown as Record<string, unknown>]);

    return updated;
  }

  async bulkDelete(
    scopeFilter: string[],
    beforeTimestamp?: number,
  ): Promise<number> {
    await this.ensureInitialized();

    const conditions: string[] = [];

    if (scopeFilter.length > 0) {
      const scopeConditions = scopeFilter
        .map((scope) => `scope = '${escapeSqlLiteral(validateScope(scope))}'`)
        .join(" OR ");
      conditions.push(`(${scopeConditions} OR scope IS NULL)`);
    }

    if (beforeTimestamp !== undefined) {
      const ts = Math.trunc(Number(beforeTimestamp));
      if (!Number.isFinite(ts)) throw new Error('beforeTimestamp must be a finite number');
      conditions.push(`timestamp < ${ts}`);
    }

    if (conditions.length === 0) {
      throw new Error(
        "Bulk delete requires at least scope or timestamp filter for safety",
      );
    }

    const whereClause = conditions.join(" AND ");

    // Count first (select only id to minimize memory)
    const countResults = await this.table!.query().where(whereClause).select(["id"]).toArray();
    const deleteCount = countResults.length;

    // Then delete
    if (deleteCount > 0) {
      await this.table!.delete(whereClause);
    }

    return deleteCount;
  }

  /**
   * Check which IDs from a list actually exist in the table.
   * Used by the retriever's ghost-check to validate BM25-only results.
   */
  async filterExistingIds(ids: string[]): Promise<Set<string>> {
    await this.ensureInitialized();
    if (ids.length === 0) return new Set();
    const escapedIds = ids.map(id => `'${escapeSqlLiteral(id)}'`).join(', ');
    const rows = await this.table!.query()
      .where(`id IN (${escapedIds})`)
      .select(['id'])
      .toArray();
    return new Set(rows.map((r: any) => r.id as string));
  }

  /**
   * Partial metadata update without re-embedding.
   * Merges `patch` into the existing metadata JSON, preserving all other fields.
   */
  async patchMetadata(
    id: string,
    patch: Record<string, unknown>,
    scopeFilter?: string[],
  ): Promise<boolean> {
    await this.ensureInitialized();

    const entry = await this.getById(id);
    if (!entry) return false;

    // Check scope permissions
    if (scopeFilter && scopeFilter.length > 0 && !scopeFilter.includes(entry.scope)) {
      return false;
    }

    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(entry.metadata || '{}'); } catch { /* ignore */ }
    const merged = { ...parsed, ...patch };

    const safeId = escapeSqlLiteral(id);
    await this.table!.delete(`id = '${safeId}'`);
    await this.table!.add([{
      ...entry,
      metadata: JSON.stringify(merged),
    } as unknown as Record<string, unknown>]);

    return true;
  }

  /**
   * Lexical fallback search: in-memory text matching against l0/l1/l2 metadata
   * fields when FTS index is unavailable. Returns matches sorted by relevance.
   */
  async lexicalFallbackSearch(
    query: string,
    limit: number = 5,
    scopeFilter?: string[],
  ): Promise<MemorySearchResult[]> {
    await this.ensureInitialized();

    // Fetch entries (capped for performance)
    const entries = await this.list(scopeFilter, undefined, 500, 0);
    if (entries.length === 0) return [];

    const queryLower = query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter(t => t.length > 2);
    if (queryTerms.length === 0) return [];

    const scored: MemorySearchResult[] = [];

    for (const entry of entries) {
      let meta: Record<string, unknown> = {};
      try { meta = JSON.parse(entry.metadata || '{}'); } catch { /* ignore */ }

      // Build searchable text from metadata levels + entry text
      const searchText = [
        entry.text,
        meta.l0_abstract as string || '',
        meta.l1_overview as string || '',
        meta.l2_content as string || '',
      ].join(' ').toLowerCase();

      // Score based on term matches
      let matchCount = 0;
      for (const term of queryTerms) {
        if (searchText.includes(term)) matchCount++;
      }

      if (matchCount === 0) continue;

      // Normalize score: proportion of query terms matched
      const score = matchCount / queryTerms.length;

      scored.push({
        entry: { ...entry, vector: [] },
        score: Math.min(score, 0.95), // Cap below 1.0
      });
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  get hasFtsSupport(): boolean {
    return this.ftsSupported;
  }

  get hasFtsIndex(): boolean {
    return this.ftsIndexCreated;
  }

  get canUseFts(): boolean {
    return this.ftsSupported && this.ftsIndexCreated;
  }

  getFtsStatus(): { supported: boolean; indexExists: boolean; lastError: string | null } {
    return {
      supported: this.ftsSupported,
      indexExists: this.ftsIndexCreated,
      lastError: this.lastFtsError,
    };
  }

  async rebuildFtsIndex(): Promise<{ success: boolean; error?: string }> {
    await this.ensureInitialized();
    if (!this.table) {
      return { success: false, error: "Table not initialized" };
    }
    if (!this.ftsSupported) {
      return { success: false, error: "FTS is not supported by the current LanceDB version" };
    }

    // Drop existing FTS index if present
    try {
      const indices = await this.table.listIndices();
      const ftsIndex = indices?.find(
        (idx: any) => idx.indexType === "FTS" || idx.columns?.includes("text"),
      );
      if (ftsIndex && ftsIndex.name) {
        await this.table.dropIndex(ftsIndex.name);
      }
    } catch (dropErr) {
      console.warn("Failed to drop existing FTS index, attempting force-create:", dropErr);
    }

    // Rebuild (force=true to skip hasFtsIndex early-return)
    try {
      await this.createFtsIndex(this.table, true);
      this.ftsIndexCreated = true;
      this.lastFtsError = null;
      return { success: true };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.ftsIndexCreated = false;
      this.lastFtsError = errMsg;
      return { success: false, error: errMsg };
    }
  }
}
