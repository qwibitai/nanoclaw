import {
  countAllMemories,
  countMemories,
  deleteMemoryById,
  getMemoryById,
  insertMemory,
  insertMemoryEmbedding,
  listMemories,
  recentMemories,
  recentMemoriesAllGroups,
  searchMemoriesVec,
  searchMemoriesVecAllGroups,
  updateMemoryFields,
} from './db.js';
import { generateEmbedding } from './embedding.js';
import { logger } from './logger.js';
import { escapeXml } from './router.js';
import { Memory } from './types.js';

const TOP_K = 6;

function embedAndStore(id: string, text: string): void {
  generateEmbedding(text)
    .then((embedding) => {
      if (!embedding) return;
      insertMemoryEmbedding(id, Buffer.from(embedding.buffer));
    })
    .catch((err) => {
      logger.warn({ err, memoryId: id }, 'Failed to store memory embedding');
    });
}

export function saveMemory(
  groupFolder: string,
  type: Memory['type'],
  name: string,
  description: string,
  content: string,
): string {
  const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  insertMemory({
    id,
    group_folder: groupFolder,
    type,
    name,
    description,
    content,
    created_at: now,
    updated_at: now,
  });

  // Generate embedding asynchronously — memory is queryable via keyword immediately
  embedAndStore(id, `${name}: ${description}\n\n${content}`);

  logger.info({ id, groupFolder, type, name }, 'Memory saved');
  return id;
}

export function deleteMemory(groupFolder: string, id: string): boolean {
  return deleteMemoryById(groupFolder, id);
}

export function updateMemory(
  groupFolder: string,
  id: string,
  fields: Partial<Pick<Memory, 'type' | 'name' | 'description' | 'content'>>,
): boolean {
  const updated = updateMemoryFields(groupFolder, id, fields);
  if (!updated) return false;

  // Re-embed if content-affecting fields changed
  if (fields.content !== undefined || fields.name !== undefined) {
    const row = getMemoryById(groupFolder, id);
    if (row) {
      embedAndStore(id, `${row.name}: ${row.description}\n\n${row.content}`);
    }
  }
  return true;
}

export function formatMemoryBlock(memories: Memory[]): string {
  if (memories.length === 0) return '';
  const items = memories
    .map(
      (m) =>
        `  <memory type="${escapeXml(m.type)}" name="${escapeXml(m.name)}" updated="${m.updated_at.slice(0, 10)}">\n    ${escapeXml(m.content)}\n  </memory>`,
    )
    .join('\n');
  return `<memories>\n${items}\n</memories>\n`;
}

/**
 * Retrieve relevant memories and format as XML block for prompt injection.
 *
 * @param crossGroup — When true (personal/main groups), retrieves from ALL groups.
 *   When false (isolated groups like Illysium Slack), scoped to own group only.
 */
export async function getMemoryBlock(
  groupFolder: string,
  queryText: string,
  crossGroup = false,
): Promise<string> {
  try {
    // Fast-path: skip embedding call if no memories exist
    const count = crossGroup ? countAllMemories() : countMemories(groupFolder);
    if (count === 0) return '';

    const fetchRecent = () =>
      crossGroup
        ? recentMemoriesAllGroups(TOP_K)
        : recentMemories(groupFolder, TOP_K);

    if (crossGroup) {
      // Cross-group search uses its own vec function; can't go through
      // searchMemoriesSemantic which is single-group scoped.
      const embedding = await generateEmbedding(queryText).catch(() => null);
      let memories: Memory[];
      if (embedding) {
        try {
          memories = searchMemoriesVecAllGroups(embedding, TOP_K);
          if (memories.length === 0) memories = fetchRecent();
        } catch (err) {
          logger.warn(
            { err },
            'vec_memories search failed, falling back to recent',
          );
          memories = fetchRecent();
        }
      } else {
        memories = fetchRecent();
      }
      return formatMemoryBlock(memories);
    }

    const memories = await searchMemoriesSemantic(
      groupFolder,
      queryText,
      TOP_K,
      () => fetchRecent(),
    );
    return formatMemoryBlock(memories);
  } catch (err) {
    logger.warn({ err, groupFolder }, 'Memory retrieval error — skipping');
    return '';
  }
}

/**
 * Semantic memory search: embed the query, vector-search, fall back to a
 * caller-provided fallback (keyword search or recent memories).
 */
export async function searchMemoriesSemantic(
  groupFolder: string,
  query: string,
  limit: number,
  fallback: (group: string, query: string, limit: number) => Memory[],
): Promise<Memory[]> {
  const embedding = await generateEmbedding(query).catch(() => null);
  let results: Memory[] = [];
  if (embedding) {
    try {
      results = searchMemoriesVec(groupFolder, embedding, limit);
    } catch (err) {
      logger.warn(
        { err },
        'vec_memories search failed, falling back to keyword',
      );
      results = fallback(groupFolder, query, limit);
    }
  }
  if (results.length === 0) {
    results = fallback(groupFolder, query, limit);
  }
  return results;
}

// Re-export DB query functions for IPC handlers
export { listMemories, searchMemoriesKeyword } from './db.js';
