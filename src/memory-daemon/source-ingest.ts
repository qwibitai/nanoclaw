import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import { openMnemonIngestDb } from '../db/migrations/019-mnemon-ingest-db.js';
import type { MemoryStore, FactInput } from '../modules/memory/store.js';
import { redactSecrets } from '../modules/memory/secret-redactor.js';
import { callClassifier, EXTRACTOR_VERSION, PROMPT_VERSION } from './classifier-client.js';
import { MIN_FACT_IMPORTANCE } from './classifier.js';
import { validateFactsAgainstSource } from './classifier-validator.js';
import { recordOrIncrementFailure, deleteAfterSuccess } from './dead-letters.js';
import type { HealthRecorder } from './health.js';

export interface IngestSweepResult {
  watchersOpened: number;
  watchersClosed: number;
  filesIngested: number;
  factsWritten: number;
  failures: number;
}

const EXTRACTOR_SYSTEM_PROMPT = `You are a memory extraction assistant. Your job is to read a source document and extract atomic, reusable facts worth storing in a long-term memory system.

Output ONLY valid JSON matching this exact schema:
{
  "worth_storing": boolean,
  "facts": [
    {
      "content": string,
      "category": "preference" | "decision" | "insight" | "fact" | "context",
      "importance": number (1-5),
      "entities": string[],
      "source_role": "external"
    }
  ]
}

Rules:
- Set worth_storing to false and return an empty facts array if the document contains no durable information.
- Extract atomic facts — one clear, self-contained statement per fact.
- Preferred categories: preference, decision, insight, fact, context.
- Importance: 5 = critical/high-signal, 1 = low-signal background detail.
- NEVER extract secrets, credentials, API keys, tokens, passwords, or transient state.
- source_role must always be "external" for ingested source files.

GROUNDING DISCIPLINE (critical — confabulation hazard):
- Do NOT introduce names, acronyms, aliases, expansions, dates, owners, statuses, or causal claims that are not LITERALLY present in the source document.
- Acronyms are especially dangerous: if the source says "WG", write "WG". Do NOT expand it to "(William Grant)" or any other parenthetical unless that exact parenthetical appears verbatim in the source.
- Do NOT add definitions, descriptions, or context that "would help" the reader unless that information is in the document.
- The fact's "content" field may compress phrasing or fix grammar, but it must not introduce a single word's worth of meaning that isn't in the source.
- Every entity in "entities[]" must be a string the source explicitly used.
- If a fact cannot be stated using only information present in the source, do not emit it.`;

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Canonicalize for stable hashing. Strip null bytes here as well as in the
 * classifier-client facade so processed_sources.content_sha256 and
 * idempotency_keys reference the SAME string the model receives. Without this
 * the hash references bytes the model never saw, which silently breaks dedup
 * (two files identical modulo \0 would have different hashes) and idempotency
 * round-trips. The binary-detection pass (looksBinary) already rejects any
 * file containing a null byte, but stripping in canonicalize is defense in
 * depth for unfamiliar edge cases.
 */
function canonicalize(content: string): string {
  return content.trim().replace(/\r\n/g, '\n').replace(/\0/g, '');
}

/**
 * Heuristic binary detection. Returns true if the input is binary (PNG, GIF,
 * ZIP, etc.) and should not be fed to the classifier as text.
 *
 * Two-pass design (Codex Finding F2, 2026-05-04):
 * - Pass 1: FULL scan for null bytes. Any \0 anywhere in the buffer flags
 *   the file as binary. The earlier 8KB-sample-only version let
 *   text-prefix-then-binary files slip through (a 9KB-clean text header
 *   followed by binary payload would not trip the guard); Codex correctly
 *   called that out. Full-scan is O(N) bytewise — cheap enough.
 * - Pass 2: density check on the first 8KB. If >5% of sample bytes are
 *   non-printable control bytes (excluding tab/LF/CR), flag as binary.
 *   Catches binary headers without flagging long UTF-8 docs that happen to
 *   contain occasional control chars (BOM, NEL, etc.).
 *
 * Accepts Buffer (preferred — runs before UTF-8 decode) or string. Buffer
 * input avoids the surprise of `String.charCodeAt` returning UTF-16 code
 * units for multibyte sequences instead of raw bytes.
 *
 * Two failure modes this prevents:
 * 1. Node `spawn()` rejects args containing `\0` with TypeError [ERR_INVALID_ARG_VALUE].
 *    Codex backend pushes the prompt as a positional arg, so a null byte
 *    anywhere in the source content kills the whole spawn.
 * 2. Codex CLI exits 0 without writing `--output-last-message` when the model
 *    sees garbage input and emits no final message. Looks like a transient
 *    failure but is deterministic for binary content; retries always poison.
 */
/**
 * Codex F6 hardening (round 2, 2026-05-05): walk a chain of path components
 * starting from `parent`, lstat each level, and reject if any intermediate
 * component is a symlink (or a non-directory). Components that don't exist
 * yet pass — the daemon mkdir's them as regular dirs at need, and the next
 * sweep re-validates.
 *
 * Why this exists despite the existing realpath-on-file check in runSweep:
 * `fs.readdirSync(inboxPath)` and `fs.realpathSync(inboxPath)` BOTH follow
 * symlinks silently. If `<project>/sources/inbox` is a symlink to another
 * project's inbox, then realpath resolves to the OTHER project's path and
 * the file's startsWith check passes — but every ingested file lands in
 * the WRONG store, breaking cross-tenant isolation. This walks the chain
 * with lstat to catch the dir-symlink before it traverses.
 *
 * Use at every entry point that reads or writes within a group's
 * sources/inbox tree: discoverMemoryGroups (cheap up-front filter),
 * reconcileWatchers (before opening fs.watch), runSweep (before
 * readdirSync), and processInboxFile (before opening the FD).
 */
export function isNonSymlinkChain(parent: string, ...components: string[]): boolean {
  // Codex F9 round 3 (2026-05-05): validate `parent` itself first. The
  // earlier version started at `parent/components[0]`, leaving the parent
  // free to be replaced with a symlink between discovery and use — a
  // post-discovery root-swap bypass. Failing closed if parent is missing,
  // a symlink, or not a directory closes that window.
  let parentSt: fs.Stats;
  try {
    parentSt = fs.lstatSync(parent);
  } catch {
    return false;
  }
  if (parentSt.isSymbolicLink()) return false;
  if (!parentSt.isDirectory()) return false;

  let current = parent;
  for (const comp of components) {
    current = path.join(current, comp);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(current);
    } catch {
      // Component doesn't exist yet — fine. Daemon will mkdir as a regular
      // directory; next sweep re-validates.
      return true;
    }
    if (st.isSymbolicLink()) return false;
    if (!st.isDirectory()) return false;
  }
  return true;
}

export function looksBinary(input: Buffer | string): boolean {
  const data = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  if (data.length === 0) return false;

  // Pass 1: full scan for null bytes — never let one through, regardless of
  // file size. This is the load-bearing change vs the old 8KB-only version.
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0) return true;
  }

  // Pass 2: density check on first 8KB. The threshold is calibrated for
  // catching binary file headers without flagging realistic text.
  const sampleEnd = Math.min(8192, data.length);
  let nonPrintable = 0;
  for (let i = 0; i < sampleEnd; i++) {
    const c = data[i];
    // Allow tab (9), LF (10), CR (13), and any high-bit byte (>=0x80) which
    // is a UTF-8 multibyte continuation. Flag other ASCII control bytes.
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) {
      nonPrintable++;
    }
  }
  return nonPrintable / sampleEnd > 0.05;
}

function dateFolder(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Move a successfully-processed inbox file into <sourcesBasePath>/sources/processed/<date>/.
 * Re-runs the chain validation immediately before mkdir + rename — codex F8
 * round 3 (2026-05-05) flagged that processInboxFile validates once at the
 * top, then does async classifier work, then moves files much later. A
 * tenant could swap `sources/processed` for a symlink in that window. This
 * helper closes the use-time window: chain check, then the IO sequence,
 * with no async gap between.
 *
 * Returns true on success, false if the chain check fails or any IO step
 * throws. Failure is best-effort: the next sweep re-detects the file in the
 * inbox and re-processes via the existing dedup path. No work is lost.
 */
function moveFileToProcessed(filePath: string, sourcesBasePath: string): boolean {
  // Codex F10 round 4 (2026-05-05): also validate the date subdir.
  // moveFileToProcessed previously chain-checked `sources/processed` but then
  // appended dateFolder() unchecked. An attacker with write access to
  // `sources/processed` can pre-create today's date dir as a symlink;
  // mkdirSync({ recursive: true }) accepts the existing dir as-is and
  // renameSync follows the link. Validate the full 3-component chain.
  const date = dateFolder();
  if (!isNonSymlinkChain(sourcesBasePath, 'sources', 'processed', date)) {
    return false;
  }
  try {
    const processedDir = path.join(sourcesBasePath, 'sources', 'processed', date);
    fs.mkdirSync(processedDir, { recursive: true });
    // Re-lstat the date dir AFTER mkdir to catch a race where the attacker
    // turned the dir into a symlink between the chain check and now. mkdir
    // is a no-op on an existing symlink-to-dir, so rename would still
    // follow without this guard.
    const dateStat = fs.lstatSync(processedDir);
    if (dateStat.isSymbolicLink() || !dateStat.isDirectory()) return false;
    fs.renameSync(filePath, path.join(processedDir, path.basename(filePath)));
    return true;
  } catch {
    return false;
  }
}

let _db: Database.Database | null = null;

function getIngestDb(): Database.Database {
  if (!_db) {
    _db = openMnemonIngestDb();
  }
  return _db;
}

/** For tests: inject a pre-opened ingest DB. */
export function setIngestDb(db: Database.Database): void {
  _db = db;
}

export class SourceIngester {
  private watchers = new Map<string, fs.FSWatcher>();
  private store: MemoryStore | null = null;
  private health: HealthRecorder | null = null;

  /**
   * Inject the production runtime dependencies. Required before the inotify
   * watcher fires can extract facts — without these, the watcher's
   * processInboxFile call hits the legacy Database-only branch (test seam)
   * and silently no-ops.
   */
  setRuntime(store: MemoryStore, health: HealthRecorder): void {
    this.store = store;
    this.health = health;
  }

  reconcileWatchers(
    groups: ReadonlyArray<{ agentGroupId: string; folder: string; sourcesBasePath: string; enabled: boolean }>,
  ): {
    opened: number;
    closed: number;
  } {
    let opened = 0;
    let closed = 0;

    const enabledIds = new Set(groups.filter((g) => g.enabled).map((g) => g.agentGroupId));

    for (const [agentGroupId, watcher] of this.watchers) {
      if (!enabledIds.has(agentGroupId)) {
        watcher.close();
        this.watchers.delete(agentGroupId);
        closed++;
      }
    }

    for (const group of groups) {
      if (!group.enabled) continue;
      if (this.watchers.has(group.agentGroupId)) continue;

      // Codex F6 round 2: re-validate the chain before opening the watcher.
      // fs.watch follows symlinks silently; if `sources/inbox` is symlinked
      // to another group's inbox, the watcher fires on victim writes and the
      // setImmediate processInboxFile call ingests them into THIS group's
      // store. Re-validating closes the TOCTOU window between discovery and
      // watch-open, even though discovery already filtered.
      if (!isNonSymlinkChain(group.sourcesBasePath, 'sources', 'inbox')) continue;

      const inboxPath = path.join(group.sourcesBasePath, 'sources', 'inbox');
      try {
        fs.mkdirSync(inboxPath, { recursive: true });
      } catch {
        // best-effort
      }

      const watcher = fs.watch(inboxPath, { persistent: false });
      // Only fire on CLOSE_WRITE (write + close) and MOVED_TO events.
      // Node's fs.watch on Linux uses inotify; 'rename' event maps to IN_MOVED_TO.
      // 'change' event maps to IN_CLOSE_WRITE. We protect against partial writes
      // by checking file existence before processing (atomic-write race protection).
      watcher.on('change', (eventType: string, filename: string | Buffer | null) => {
        if (eventType !== 'rename' && eventType !== 'change') return;
        if (!filename) return;
        const filePath = path.join(inboxPath, filename.toString());
        // Reject symlinks and any path that escapes the inbox root (cross-tenant
        // attack: container could plant a symlink to another group's file or
        // any host-readable path).
        let stat: fs.Stats;
        try {
          stat = fs.lstatSync(filePath);
        } catch {
          return;
        }
        if (stat.isSymbolicLink() || !stat.isFile()) return;
        let realPath: string;
        let inboxRealPath: string;
        try {
          realPath = fs.realpathSync(filePath);
          inboxRealPath = fs.realpathSync(inboxPath);
        } catch {
          return;
        }
        if (!realPath.startsWith(inboxRealPath + path.sep)) return;
        // Defer to allow the write to fully flush.
        setImmediate(() => {
          // The watcher fast-path needs the production MemoryStore + HealthRecorder
          // (not the Database-only test seam). If setRuntime wasn't called, fall
          // back silently — the 60s sweep in index.ts catches the file and
          // processes it via the runtime path.
          if (!this.store) return;
          void this.processInboxFile(
            group.agentGroupId,
            group.sourcesBasePath,
            realPath,
            this.store,
            this.health ?? undefined,
          );
        });
      });

      this.watchers.set(group.agentGroupId, watcher);
      opened++;
    }

    return { opened, closed };
  }

  async processInboxFile(
    agentGroupId: string,
    sourcesBasePath: string,
    filePath: string,
    store: MemoryStore | Database.Database,
    health?: HealthRecorder,
  ): Promise<{ factsWritten: number; failed: boolean }>;

  async processInboxFile(
    agentGroupId: string,
    sourcesBasePath: string,
    filePath: string,
    storeOrDb: MemoryStore | Database.Database,
    health?: HealthRecorder,
  ): Promise<{ factsWritten: number; failed: boolean }> {
    // Re-validate symlink/path-traversal protection at read time, then read
    // through a file descriptor opened with O_NOFOLLOW to close the TOCTOU
    // window. The watcher ran lstat+realpath before queuing, but setImmediate
    // creates a window where a container with write access to its inbox could
    // swap the regular file for a symlink. Reading by path after re-validation
    // (Codex finding #5 round 1) still has a residual race; openSync with
    // O_NOFOLLOW + fstat eliminates it (Codex finding #2 round 2).
    //
    // Codex F6 round 2 (2026-05-05): also re-validate the dir chain. If
    // `sources` or `sources/inbox` is a symlink to another group's inbox,
    // the realpath resolves to the OTHER group's path and every file's
    // startsWith check passes — but each ingested file lands in the WRONG
    // store. Same applies to `sources/processed` for the post-classification
    // move (codex called out that processed moves can relocate victim files
    // out of their own inbox). Reject before opening or moving anything.
    if (
      !isNonSymlinkChain(sourcesBasePath, 'sources', 'inbox') ||
      !isNonSymlinkChain(sourcesBasePath, 'sources', 'processed')
    ) {
      return { factsWritten: 0, failed: false };
    }
    const inboxPath = path.join(sourcesBasePath, 'sources', 'inbox');
    let content: string;
    try {
      // Resolve the inbox root for the prefix check below. openSync with
      // O_NOFOLLOW will refuse to open the file if the final path component
      // is a symlink — but earlier components could still be symlinks, so
      // realpath the inbox to compare against the fd's resolved path.
      const inboxRealPath = fs.realpathSync(inboxPath);

      // O_NOFOLLOW = 0o400000 on Linux. Importing fs/promises constants is
      // cleaner but constants.O_NOFOLLOW is fs.constants.O_NOFOLLOW.
      const O_NOFOLLOW = fs.constants.O_NOFOLLOW;
      const O_RDONLY = fs.constants.O_RDONLY;
      const fd = fs.openSync(filePath, O_RDONLY | O_NOFOLLOW);
      try {
        const fstat = fs.fstatSync(fd);
        if (!fstat.isFile()) {
          return { factsWritten: 0, failed: false };
        }
        // Resolve the fd back to a real path on disk and verify it's still
        // under the inbox. Linux exposes /proc/self/fd/<fd> as a symlink
        // pointing at the actual file.
        const fdRealPath = fs.readlinkSync(`/proc/self/fd/${fd}`);
        if (!fdRealPath.startsWith(inboxRealPath + path.sep)) {
          return { factsWritten: 0, failed: false };
        }
        // Use filePath = fdRealPath downstream so processed_pairs / processed/
        // moves use the canonical path.
        filePath = fdRealPath;

        const buf = Buffer.alloc(fstat.size);
        let bytesRead = 0;
        while (bytesRead < fstat.size) {
          const r = fs.readSync(fd, buf, bytesRead, fstat.size - bytesRead, null);
          if (r === 0) break;
          bytesRead += r;
        }
        const rawBuf = buf.subarray(0, bytesRead);

        // Reject binary content BEFORE UTF-8 decode (Codex Finding F2).
        // Running the heuristic on the raw Buffer (a) catches null bytes
        // anywhere in the file, not just the first 8KB, and (b) avoids the
        // surprise of charCodeAt returning UTF-16 code units instead of
        // raw bytes. PNG/GIF/PDF attachments produce strings with null
        // bytes that crash spawn() in the codex backend, or all-binary
        // sequences that make codex exit 0 without writing output (looks
        // like a transient failure but is deterministic; retries always
        // poison). Move the file to processed/ and clear any dead_letter
        // row so a stuck file from before this guard existed retires
        // cleanly.
        if (looksBinary(rawBuf)) {
          // Codex F8 round 3: re-validate chain right before the move. The
          // top-of-function check is stale by now (we just did blocking IO).
          moveFileToProcessed(filePath, sourcesBasePath);
          // Clear dead_letter row keyed on the resolved file path so the
          // retry loop doesn't keep finding it. Without this, files that
          // were poisoned before the binary guard existed would stay in
          // dead_letters forever (they'd retry, the path wouldn't exist,
          // and the daemon would skip without ever clearing the row).
          deleteAfterSuccess(filePath, agentGroupId);
          return { factsWritten: 0, failed: false };
        }

        content = rawBuf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return { factsWritten: 0, failed: true };
    }

    const canonical = canonicalize(content);
    const contentHash = sha256(canonical);

    const db = getIngestDb();

    const existing = db
      .prepare(
        `SELECT 1 FROM processed_sources
         WHERE agent_group_id = ? AND content_sha256 = ? AND extractor_version = ? AND prompt_version = ?`,
      )
      .get(agentGroupId, contentHash, EXTRACTOR_VERSION, PROMPT_VERSION);

    if (existing) {
      // Clear any orphan dead_letters row keyed on this resolved path. A
      // prior failed attempt could have created a dead_letter that lasted
      // beyond the eventual content-hash success (different agent/path race
      // with same content). Once we move the file to processed/, the retry
      // loop's fs.existsSync check will short-circuit and the row would
      // otherwise zombie forever. Scoped by agent_group_id + item_key.
      db.prepare(`DELETE FROM dead_letters WHERE item_key = ? AND agent_group_id = ?`).run(filePath, agentGroupId);

      moveFileToProcessed(filePath, sourcesBasePath);
      return { factsWritten: 0, failed: false };
    }

    // storeOrDb can be a MemoryStore (production path) or Database (legacy test injection via setIngestDb).
    // In production, storeOrDb is always a MemoryStore.
    if (storeOrDb instanceof Database) {
      return { factsWritten: 0, failed: false };
    }
    const store = storeOrDb as MemoryStore;

    let output;
    try {
      output = await callClassifier(EXTRACTOR_SYSTEM_PROMPT, canonical);
    } catch (err) {
      if (health) {
        health.recordClassifierFailure(agentGroupId, err instanceof Error ? err : new Error(String(err)));
      }
      recordOrIncrementFailure({
        itemType: 'source-file',
        itemKey: filePath,
        agentGroupId,
        error: String(err),
      });
      return { factsWritten: 0, failed: true };
    }

    // Confabulation defense: drop facts whose content contains a parenthetical
    // alias that the extractor invented (not present in the source document).
    // Same rule as the chat-pair classifier — see classifier-validator.ts.
    {
      const validation = validateFactsAgainstSource(output, canonical);
      if (validation.rejected.length > 0) {
        for (const r of validation.rejected) {
          console.warn('[source-ingest] dropped confabulated fact', {
            agentGroupId,
            filePath,
            reason: r.reason,
            content: r.fact.content.slice(0, 200),
          });
        }
        output = { ...output, facts: validation.accepted };
      }
    }

    if (!output.worth_storing || output.facts.length === 0) {
      db.transaction(() => {
        db.prepare(
          `INSERT OR IGNORE INTO processed_sources
             (agent_group_id, content_sha256, extractor_version, prompt_version, source_path, ingested_at,
              facts_written, facts_emitted, facts_dropped_low_importance)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          agentGroupId,
          contentHash,
          EXTRACTOR_VERSION,
          PROMPT_VERSION,
          filePath,
          new Date().toISOString(),
          0,
          output.facts.length,
          0,
        );
        db.prepare(`DELETE FROM dead_letters WHERE item_key = ? AND agent_group_id = ?`).run(filePath, agentGroupId);
      })();

      moveFileToProcessed(filePath, sourcesBasePath);
      return { factsWritten: 0, failed: false };
    }

    let factsWritten = 0;
    let factsDroppedForImportance = 0;
    let anyFailed = false;

    for (let factIndex = 0; factIndex < output.facts.length; factIndex++) {
      const rawFact = output.facts[factIndex];
      const factInput: FactInput = {
        content: rawFact.content,
        category: rawFact.category,
        importance: rawFact.importance,
        entities: rawFact.entities,
        provenance: {
          sourceType: 'tool',
          sourceId: filePath,
          sourceRole: 'external',
        },
      };

      // Redaction runs BEFORE the importance gate to match classifier.ts:340.
      // Secret-shaped content is always counted in health.recordRedaction, even
      // when the fact would have been dropped for being low-signal. Audit signal
      // > store-write savings.
      const redactionResult = redactSecrets(factInput);
      if (!redactionResult.shouldStore) {
        if (health) {
          health.recordRedaction(agentGroupId, redactionResult.reason ?? 'unknown');
        }
        continue;
      }

      // Mirror the chat-pair classifier's importance gate (classifier.ts:364)
      // so source-ingested facts (CC turn-pair captures, container-agent tool
      // fetches: web/Granola/Pocket/attachments/etc.) get the same retention
      // bar as message-stream facts. Without this filter, source paths stored
      // 1-5 while chat stored only 4-5, polluting recall with low-signal noise.
      if (rawFact.importance < MIN_FACT_IMPORTANCE) {
        factsDroppedForImportance++;
        if (health) health.recordLowImportanceDropped(agentGroupId);
        continue;
      }

      const idempotencyKey = sha256(`${filePath}|${contentHash}|${factIndex}|${EXTRACTOR_VERSION}|${PROMPT_VERSION}`);
      try {
        const result = await store.remember(agentGroupId, factInput, { idempotencyKey });
        // Mirror the classifier fix (Codex post-fix #1): MnemonStore.remember
        // returns { action: 'skipped', factId: '' } on CLI failure, empty
        // stdout, or parse failure. Counting these as success would silently
        // drop facts and mark the source as processed — permanent data loss
        // without a dead-letter retry. Only count actually-stored facts.
        if (result.action === 'added' || result.action === 'updated' || result.action === 'replaced') {
          factsWritten++;
        } else if (result.action === 'skipped' && !result.factId) {
          // Operational failure masquerading as 'skipped'. The redactor-blocked
          // path is already handled above; any 'skipped' reaching here is a
          // mnemon write failure and should route the source file to dead_letters.
          anyFailed = true;
          if (health) {
            health.recordClassifierFailure(
              agentGroupId,
              new Error(`store.remember returned skipped without factId for source-file fact ${factIndex}`),
            );
          }
          break;
        }
        // result.action === 'skipped' with non-empty factId is a duplicate
        // dedup hit — count as silently-stored (idempotent retry).
      } catch (err) {
        anyFailed = true;
        if (health) {
          health.recordClassifierFailure(agentGroupId, err instanceof Error ? err : new Error(String(err)));
        }
        break;
      }
    }

    if (anyFailed) {
      recordOrIncrementFailure({
        itemType: 'source-file',
        itemKey: filePath,
        agentGroupId,
        error: 'fact write failed',
      });
      return { factsWritten: 0, failed: true };
    }

    db.transaction(() => {
      db.prepare(
        `INSERT OR IGNORE INTO processed_sources
           (agent_group_id, content_sha256, extractor_version, prompt_version, source_path, ingested_at,
            facts_written, facts_emitted, facts_dropped_low_importance)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        agentGroupId,
        contentHash,
        EXTRACTOR_VERSION,
        PROMPT_VERSION,
        filePath,
        new Date().toISOString(),
        factsWritten,
        output.facts.length,
        factsDroppedForImportance,
      );
      db.prepare(`DELETE FROM dead_letters WHERE item_key = ? AND agent_group_id = ?`).run(filePath, agentGroupId);
    })();

    if (health) {
      health.recordSourceIngest(agentGroupId, factsWritten, contentHash);
    }

    moveFileToProcessed(filePath, sourcesBasePath);
    return { factsWritten, failed: false };
  }

  async shutdown(): Promise<void> {
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
  }
}
