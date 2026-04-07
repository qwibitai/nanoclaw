/**
 * 结构化记忆系统 — 统一入口
 *
 * 导出核心 API：memoryQueue, injectMemory, getMemoryConfig
 */
import { getMemoryConfig } from './config.js';
import { getMemoryDb, backfillFtsIndex } from './storage.js';
import { MemoryUpdateQueue } from './queue.js';
import { injectMemory } from './inject.js';
import { logger } from '../logger.js';

export { getMemoryConfig } from './config.js';
export { injectMemory } from './inject.js';
export { MemoryStore } from './memory-store.js';

let _queue: MemoryUpdateQueue | null = null;

/**
 * 获取全局记忆更新队列。
 * 首次调用时初始化数据库和 FTS 索引。
 */
export function getMemoryQueue(): MemoryUpdateQueue {
  if (_queue) return _queue;

  const config = getMemoryConfig();
  if (!config.enabled) {
    // 返回一个不活跃的队列（add 会被 config.enabled 检查跳过）
    _queue = new MemoryUpdateQueue();
    return _queue;
  }

  // 初始化 SQLite 数据库（含 FTS5 表）
  getMemoryDb();

  // 补录已有 facts 到 FTS 索引（S3 修复）
  backfillFtsIndex();

  _queue = new MemoryUpdateQueue();

  logger.info('结构化记忆系统已初始化');
  return _queue;
}

/**
 * 检查记忆系统是否启用
 */
export function isMemoryEnabled(): boolean {
  return getMemoryConfig().enabled;
}
