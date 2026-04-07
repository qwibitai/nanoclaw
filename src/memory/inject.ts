/**
 * 记忆注入模块 — 将记忆格式化后写入 group 目录的 CLAUDE.md
 *
 * 使用 HTML 注释标记 <!-- nanoclaw:memory:start/end --> 包裹，
 * 避免与用户手写内容冲突。
 */
import fs from 'fs';
import path from 'path';

import { getMemoryConfig } from './config.js';
import { loadFacts, loadProfile } from './storage.js';
import { formatMemoryForInjection } from './prompt.js';
import { MemoryStore } from './memory-store.js';
import { logger } from '../logger.js';

const MEMORY_START = '<!-- nanoclaw:memory:start -->';
const MEMORY_END = '<!-- nanoclaw:memory:end -->';

/**
 * 将记忆注入 group 目录的 CLAUDE.md。
 *
 * R15 改造：
 * - profile 全量注入
 * - facts 走 MemoryStore.recall(latestUserMessage) 双路召回 top-K
 * - latestUserMessage 为空时 fallback 到全量注入
 */
export async function injectMemory(
  groupFolder: string,
  groupDir: string,
  latestUserMessage?: string,
  userId: string = '',
): Promise<void> {
  const config = getMemoryConfig();
  if (!config.injectionEnabled) return;

  const profile = loadProfile(groupFolder, userId);
  const allFacts = loadFacts(groupFolder, userId);

  // 没有记忆数据时不操作
  if (!profile && allFacts.length === 0) return;

  // 决定使用哪些 facts
  let factsForInjection: Array<{
    id?: string;
    content: string;
    category: string;
    confidence: number;
  }>;

  if (latestUserMessage && allFacts.length > 0) {
    // R15.1: 双路召回 top-K
    try {
      const store = new MemoryStore(groupFolder, userId);
      const recalled = await store.recall(latestUserMessage);
      factsForInjection = recalled.map((r) => ({
        id: r.id,
        content: r.content,
        category:
          (r.metadata as Record<string, string> | null)?.category || 'context',
        confidence: r.score,
      }));
    } catch (err) {
      logger.warn({ err }, '双路召回失败，回退全量注入');
      factsForInjection = allFacts;
    }
  } else {
    // R15.3: 无消息时全量注入
    factsForInjection = allFacts;
  }

  // 组装 memoryData
  const memoryData = {
    user: (profile?.user as Record<string, unknown>) || undefined,
    history: (profile?.history as Record<string, unknown>) || undefined,
    facts: factsForInjection,
  };

  const memoryText = formatMemoryForInjection(memoryData);
  if (!memoryText) return;

  // 写入 CLAUDE.md
  const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
  const memoryBlock = `${MEMORY_START}\n## Memory\n\n${memoryText}\n${MEMORY_END}`;

  let content: string;
  if (fs.existsSync(claudeMdPath)) {
    content = fs.readFileSync(claudeMdPath, 'utf-8');

    // 检查是否已有 Memory section
    const startIdx = content.indexOf(MEMORY_START);
    const endIdx = content.indexOf(MEMORY_END);

    if (startIdx !== -1 && endIdx !== -1) {
      // 替换已有内容
      content =
        content.slice(0, startIdx) +
        memoryBlock +
        content.slice(endIdx + MEMORY_END.length);
    } else {
      // 追加到文件末尾
      content = content.trimEnd() + '\n\n' + memoryBlock + '\n';
    }
  } else {
    content = memoryBlock + '\n';
  }

  fs.writeFileSync(claudeMdPath, content);
  logger.info(
    { groupFolder, factsCount: factsForInjection.length },
    '记忆已注入 CLAUDE.md',
  );
}
