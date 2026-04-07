/**
 * 结构化记忆防抖队列 — 从 Nine structured/queue.py 翻译
 *
 * 同一 group_folder 的多次提交只保留最新 messages，
 * 防抖到期后批量触发 LLM 提取。
 * NanoClaw 适配：单进程 setTimeout 替代 Python threading.Timer。
 */
import { getMemoryConfig } from './config.js';
import { MemoryUpdater } from './updater.js';
import { ConversationMessage } from './prompt.js';
import { logger } from '../logger.js';

interface QueueEntry {
  groupFolder: string;
  messages: ConversationMessage[];
  sessionId?: string;
  userId: string;
  timestamp: number;
}

export class MemoryUpdateQueue {
  private queue: QueueEntry[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private processing = false;

  /**
   * 将对话加入更新队列。
   * 同一 groupFolder 覆盖旧消息，重置防抖计时。
   */
  add(
    groupFolder: string,
    messages: ConversationMessage[],
    sessionId?: string,
    userId: string = '',
  ): void {
    const config = getMemoryConfig();
    if (!config.enabled) return;

    // 同 groupFolder + userId 覆盖
    this.queue = this.queue.filter(
      (e) => !(e.groupFolder === groupFolder && e.userId === userId),
    );
    this.queue.push({
      groupFolder,
      messages,
      sessionId,
      userId,
      timestamp: Date.now(),
    });

    this.resetTimer();

    logger.info({ groupFolder, queueSize: this.queue.length }, '记忆更新入队');
  }

  private resetTimer(): void {
    const config = getMemoryConfig();

    if (this.timer !== null) {
      clearTimeout(this.timer);
    }

    this.timer = setTimeout(
      () => this.processQueue(),
      config.debounceSeconds * 1000,
    );

    logger.debug({ seconds: config.debounceSeconds }, '防抖计时器已重置');
  }

  private async processQueue(): Promise<void> {
    if (this.processing) {
      this.resetTimer();
      return;
    }

    if (this.queue.length === 0) return;

    this.processing = true;
    const entries = [...this.queue];
    this.queue = [];
    this.timer = null;

    logger.info({ count: entries.length }, '开始处理记忆更新队列');

    try {
      const updater = new MemoryUpdater();

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        try {
          logger.info({ groupFolder: entry.groupFolder }, '更新记忆');
          const success = await updater.updateMemory(
            entry.groupFolder,
            entry.messages,
            entry.sessionId,
            entry.userId,
          );
          if (success) {
            logger.info({ groupFolder: entry.groupFolder }, '记忆更新成功');
          } else {
            logger.debug(
              { groupFolder: entry.groupFolder },
              '记忆更新跳过/失败',
            );
          }
        } catch (err) {
          logger.warn({ err, groupFolder: entry.groupFolder }, '记忆更新异常');
        }

        // R1.7: 多个更新之间延迟 500ms 防限流
        if (entries.length > 1 && i < entries.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    } finally {
      this.processing = false;

      // R1.5: 处理过程中有新入队，重新计时
      if (this.queue.length > 0) {
        this.resetTimer();
      }
    }
  }

  /**
   * 强制立即处理队列（graceful shutdown 用）
   */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.processQueue();
  }

  /**
   * 清空队列不处理（测试用）
   */
  clear(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.queue = [];
    this.processing = false;
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  get isProcessing(): boolean {
    return this.processing;
  }
}
