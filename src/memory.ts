/**
 * Memory Management for NanoClaw
 *
 * Provides persistent memory storage inspired by nanobot's memory system:
 * - Long-term memory (MEMORY.md) per group
 * - Daily notes (YYYY-MM-DD.md) per group
 * - Recent memory context assembly for agent prompts
 *
 * Security: All memory is scoped to group directories (isolated per group).
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

export class MemoryStore {
  private groupFolder: string;
  private memoryDir: string;

  constructor(groupFolder: string) {
    this.groupFolder = groupFolder;
    this.memoryDir = path.join(GROUPS_DIR, groupFolder, 'memory');
    fs.mkdirSync(this.memoryDir, { recursive: true });
  }

  /** Read the long-term memory file (MEMORY.md) */
  readLongTerm(): string {
    const filePath = path.join(this.memoryDir, 'MEMORY.md');
    try {
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, 'utf-8');
      }
    } catch (err) {
      logger.error({ err, group: this.groupFolder }, 'Error reading long-term memory');
    }
    return '';
  }

  /** Write to long-term memory */
  writeLongTerm(content: string): void {
    const filePath = path.join(this.memoryDir, 'MEMORY.md');
    try {
      fs.writeFileSync(filePath, content, 'utf-8');
      logger.debug({ group: this.groupFolder }, 'Long-term memory updated');
    } catch (err) {
      logger.error({ err, group: this.groupFolder }, 'Error writing long-term memory');
    }
  }

  /** Read today's daily notes */
  readToday(): string {
    const filePath = path.join(this.memoryDir, this.todayFilename());
    try {
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, 'utf-8');
      }
    } catch (err) {
      logger.error({ err, group: this.groupFolder }, 'Error reading daily notes');
    }
    return '';
  }

  /** Append to today's daily notes */
  appendToday(content: string): void {
    const filePath = path.join(this.memoryDir, this.todayFilename());
    try {
      const existing = fs.existsSync(filePath)
        ? fs.readFileSync(filePath, 'utf-8')
        : '';
      const updated = existing ? `${existing}\n${content}` : content;
      fs.writeFileSync(filePath, updated, 'utf-8');
    } catch (err) {
      logger.error({ err, group: this.groupFolder }, 'Error appending daily notes');
    }
  }

  /**
   * Get recent memories for context assembly.
   * Returns the last N days of daily notes + long-term memory.
   */
  getRecentMemories(days: number = 7): string {
    const parts: string[] = [];

    // Long-term memory first
    const longTerm = this.readLongTerm();
    if (longTerm) {
      parts.push('## Long-term Memory\n' + longTerm);
    }

    // Recent daily notes
    const today = new Date();
    for (let i = 0; i < days; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const filename = this.dateFilename(date);
      const filePath = path.join(this.memoryDir, filename);

      try {
        if (fs.existsSync(filePath)) {
          const stat = fs.statSync(filePath);
          if (stat.size > 10 * 1024 * 1024) {
            logger.warn({ file: filename, size: stat.size, group: this.groupFolder }, 'Memory file too large, skipping');
            continue;
          }
          const content = fs.readFileSync(filePath, 'utf-8');
          if (content.trim()) {
            const dateStr = date.toISOString().split('T')[0];
            parts.push(`## Notes from ${dateStr}\n${content}`);
          }
        }
      } catch (err) {
        logger.warn({ file: filename, err, group: this.groupFolder }, 'Failed to read memory file, skipping');
      }
    }

    return parts.join('\n\n---\n\n');
  }

  /** Get the CLAUDE.md content for this group (existing system) */
  getGroupContext(): string {
    const claudeMd = path.join(GROUPS_DIR, this.groupFolder, 'CLAUDE.md');
    try {
      if (fs.existsSync(claudeMd)) {
        return fs.readFileSync(claudeMd, 'utf-8');
      }
    } catch {
      // File doesn't exist yet
    }
    return '';
  }

  /** Get the global CLAUDE.md context */
  static getGlobalContext(): string {
    const globalMd = path.join(GROUPS_DIR, 'global', 'CLAUDE.md');
    try {
      if (fs.existsSync(globalMd)) {
        return fs.readFileSync(globalMd, 'utf-8');
      }
    } catch {
      // File doesn't exist
    }
    return '';
  }

  private todayFilename(): string {
    return this.dateFilename(new Date());
  }

  private dateFilename(date: Date): string {
    return `${date.toISOString().split('T')[0]}.md`;
  }
}
