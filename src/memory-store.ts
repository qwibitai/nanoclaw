import {
  countMemories,
  deleteMemoryById,
  getMemoryById,
  insertMemory,
  insertMemoryEmbedding,
  listMemories,
  recentMemories,
  searchMemoriesVec,
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

export async function getMemoryBlock(
  groupFolder: string,
  queryText: string,
): Promise<string> {
  try {
    // Fast-path: skip embedding call if group has no memories
    if (countMemories(groupFolder) === 0) return '';

    const embedding = await generateEmbedding(queryText);
    let memories: Memory[];
    if (embedding) {
      try {
        memories = searchMemoriesVec(groupFolder, embedding, TOP_K);
        if (memories.length === 0) {
          // No embeddings stored yet (async generation pending) — fall back to recent
          memories = recentMemories(groupFolder, TOP_K);
        }
      } catch (err) {
        logger.warn(
          { err },
          'vec_memories search failed, falling back to recent',
        );
        memories = recentMemories(groupFolder, TOP_K);
      }
    } else {
      memories = recentMemories(groupFolder, TOP_K);
    }
    return formatMemoryBlock(memories);
  } catch (err) {
    logger.warn({ err, groupFolder }, 'Memory retrieval error — skipping');
    return '';
  }
}

// Re-export DB query functions for IPC handlers
export { listMemories, searchMemoriesKeyword } from './db.js';
