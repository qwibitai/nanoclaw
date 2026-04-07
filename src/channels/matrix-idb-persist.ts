/**
 * Persistence layer for fake-indexeddb crypto store.
 *
 * The matrix-sdk-crypto-wasm Rust module stores E2EE keys in IndexedDB.
 * In Node.js, fake-indexeddb provides the API in-memory. This module
 * serialises that state to a SQLite file via better-sqlite3, so the
 * Olm account, device keys, and Megolm sessions survive process restarts.
 *
 * Layout: one SQLite file at `<storePath>/crypto-idb.sqlite` with tables
 * for database metadata, object store schemas (including indexes), and
 * the actual key-value data.
 */
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { logger } from '../logger.js';

// Minimal IDB type declarations — fake-indexeddb populates globalThis at
// runtime but the project doesn't include DOM lib types.
/* eslint-disable @typescript-eslint/no-explicit-any */
interface IDBFactoryShim {
  open(name: string, version?: number): any;
  databases(): Promise<Array<{ name?: string; version?: number }>>;
}

const idbGlobal = globalThis as unknown as {
  indexedDB?: IDBFactoryShim;
};

const SQLITE_FILE = 'crypto-idb.sqlite';

interface IndexInfo {
  name: string;
  keyPath: string | string[];
  unique: boolean;
  multiEntry: boolean;
}

interface StoreSchema {
  name: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  indexes: IndexInfo[];
}

/**
 * Dump all IndexedDB databases to a SQLite file on disk.
 */
export async function persistCryptoStore(storePath: string): Promise<void> {
  const idb = idbGlobal.indexedDB;
  if (!idb || typeof idb.databases !== 'function') return;

  const databases = await idb.databases();
  if (databases.length === 0) return;

  const sqlitePath = path.join(storePath, SQLITE_FILE);
  const sqlDb = new Database(sqlitePath);
  sqlDb.pragma('journal_mode = WAL');

  sqlDb.exec(`
    CREATE TABLE IF NOT EXISTS idb_meta (
      db      TEXT NOT NULL PRIMARY KEY,
      version INTEGER NOT NULL,
      schema  TEXT NOT NULL
    )
  `);
  sqlDb.exec(`
    CREATE TABLE IF NOT EXISTS idb_data (
      db    TEXT NOT NULL,
      store TEXT NOT NULL,
      key   TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (db, store, key)
    )
  `);

  const insertMeta = sqlDb.prepare(
    'INSERT OR REPLACE INTO idb_meta (db, version, schema) VALUES (?, ?, ?)',
  );
  const insertData = sqlDb.prepare(
    'INSERT OR REPLACE INTO idb_data (db, store, key, value) VALUES (?, ?, ?, ?)',
  );
  const clearData = sqlDb.prepare('DELETE FROM idb_data WHERE db = ?');

  for (const dbInfo of databases) {
    if (!dbInfo.name) continue;

    const db = await openIDB(dbInfo.name, dbInfo.version);
    const storeSchemas: StoreSchema[] = [];

    // Capture full schema: stores, keyPaths, indexes
    for (const storeName of db.objectStoreNames) {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const indexes: IndexInfo[] = [];
      for (const idxName of store.indexNames) {
        const idx = store.index(idxName);
        indexes.push({
          name: idxName,
          keyPath: idx.keyPath,
          unique: idx.unique,
          multiEntry: idx.multiEntry,
        });
      }
      storeSchemas.push({
        name: storeName,
        keyPath: store.keyPath,
        autoIncrement: store.autoIncrement,
        indexes,
      });
    }

    // Write schema and data in a single SQLite transaction
    const writeAll = sqlDb.transaction(() => {
      clearData.run(dbInfo.name);
      insertMeta.run(
        dbInfo.name,
        dbInfo.version ?? 1,
        JSON.stringify(storeSchemas),
      );
    });
    writeAll();

    // Read and persist data from each object store
    for (const schema of storeSchemas) {
      const records = await readAllRecords(db, schema.name);
      if (records.length > 0) {
        const batchInsert = sqlDb.transaction(() => {
          for (const { key, value } of records) {
            insertData.run(dbInfo.name, schema.name, key, value);
          }
        });
        batchInsert();
      }
    }
    db.close();
  }

  sqlDb.close();
  logger.info(
    { sqlitePath, databases: databases.length },
    'Matrix crypto store persisted to disk',
  );
}

/**
 * Restore IndexedDB databases from the SQLite file on disk.
 * Must be called before initRustCrypto, after fake-indexeddb is loaded.
 */
export async function restoreCryptoStore(storePath: string): Promise<boolean> {
  const sqlitePath = path.join(storePath, SQLITE_FILE);
  if (!fs.existsSync(sqlitePath)) return false;

  const idb = idbGlobal.indexedDB;
  if (!idb) return false;

  let sqlDb: InstanceType<typeof Database>;
  try {
    sqlDb = new Database(sqlitePath, { readonly: true });
  } catch (err) {
    logger.warn({ err, sqlitePath }, 'Failed to open crypto store SQLite file');
    return false;
  }

  let metaRows: Array<{ db: string; version: number; schema: string }>;
  try {
    metaRows = sqlDb
      .prepare('SELECT db, version, schema FROM idb_meta')
      .all() as typeof metaRows;
  } catch {
    sqlDb.close();
    return false;
  }

  if (metaRows.length === 0) {
    sqlDb.close();
    return false;
  }

  const dataStmt = sqlDb.prepare(
    'SELECT store, key, value FROM idb_data WHERE db = ?',
  );

  for (const meta of metaRows) {
    const storeSchemas: StoreSchema[] = JSON.parse(meta.schema);
    const rows = dataStmt.all(meta.db) as Array<{
      store: string;
      key: string;
      value: string;
    }>;

    // Group records by store name
    const byStore = new Map<string, Array<{ key: string; value: string }>>();
    for (const row of rows) {
      let arr = byStore.get(row.store);
      if (!arr) {
        arr = [];
        byStore.set(row.store, arr);
      }
      arr.push({ key: row.key, value: row.value });
    }

    // Recreate the database with full schema (stores + indexes)
    const db: any = await new Promise((resolve, reject) => {
      const req = idb.open(meta.db, meta.version);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const schema of storeSchemas) {
          if (db.objectStoreNames.contains(schema.name)) continue;
          const storeOpts: any = {};
          if (schema.keyPath != null) storeOpts.keyPath = schema.keyPath;
          if (schema.autoIncrement) storeOpts.autoIncrement = true;
          const store = db.createObjectStore(schema.name, storeOpts);
          for (const idx of schema.indexes) {
            store.createIndex(idx.name, idx.keyPath, {
              unique: idx.unique,
              multiEntry: idx.multiEntry,
            });
          }
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    // Write records back into each object store
    for (const [storeName, records] of byStore) {
      if (!db.objectStoreNames.contains(storeName)) continue;
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        for (const { key, value } of records) {
          store.put(JSON.parse(value), key);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
    db.close();
  }

  sqlDb.close();
  logger.info(
    { sqlitePath, databases: metaRows.length },
    'Matrix crypto store restored from disk',
  );
  return true;
}

// --- Helpers ---

function openIDB(name: string, version?: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = idbGlobal.indexedDB!.open(name, version);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function readAllRecords(
  db: any,
  storeName: string,
): Promise<Array<{ key: string; value: string }>> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const results: Array<{ key: string; value: string }> = [];

    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        results.push({
          key: String(cursor.key),
          value: JSON.stringify(cursor.value),
        });
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve(results);
    tx.onerror = () => reject(tx.error);
  });
}
