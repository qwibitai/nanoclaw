/**
 * Context Assembler for NanoClaw
 *
 * Pre-assembles a context packet for each agent container, including:
 * - Current date/time/timezone
 * - Group memory.md content
 * - current.md priorities
 * - Recent messages in the group
 * - Active scheduled tasks
 * - Pending message bus items
 */
import fs from 'fs';
import path from 'path';

import {
  CONTEXT_PACKET_MAX_SIZE,
  DATA_DIR,
  GROUPS_DIR,
  TIMEZONE,
} from './config.js';
import { getRecentMessages, getAllTasks } from './db.js';

export function assembleContextPacket(
  groupFolder: string,
  isMain: boolean,
): string {
  const sections: string[] = [];

  // 1. Date and timezone
  const now = new Date();
  sections.push(
    `Current date: ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`,
  );
  sections.push(
    `Current time: ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`,
  );
  sections.push(`Timezone: ${TIMEZONE}`);

  // 2. Group memory.md
  const memoryPath = path.join(GROUPS_DIR, groupFolder, 'memory.md');
  if (fs.existsSync(memoryPath)) {
    const memory = fs.readFileSync(memoryPath, 'utf-8');
    if (memory.trim()) {
      sections.push(`\n--- Group Memory ---\n${memory.slice(0, 2000)}`);
    }
  }

  // 3. current.md priorities
  const currentPath = path.join(GROUPS_DIR, 'global', 'state', 'current.md');
  if (fs.existsSync(currentPath)) {
    const current = fs.readFileSync(currentPath, 'utf-8');
    if (current.trim()) {
      sections.push(`\n--- Current Priorities ---\n${current.slice(0, 1500)}`);
    }
  }

  // 4. Recent messages (last 10)
  try {
    const messages = getRecentMessages(groupFolder);
    if (messages.length > 0) {
      const formatted = messages
        .slice(-10)
        .map(
          (m) =>
            `[${new Date(m.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}] ${m.sender}: ${m.content.slice(0, 200)}`,
        )
        .join('\n');
      sections.push(`\n--- Recent messages ---\n${formatted}`);
    }
  } catch {
    // DB not initialized yet or query failed, skip
  }

  // 5. Active scheduled tasks
  try {
    const tasks = getAllTasks();
    const groupTasks = tasks
      .filter((t) => t.status === 'active')
      .filter((t) => isMain || t.group_folder === groupFolder);
    if (groupTasks.length > 0) {
      const formatted = groupTasks
        .map(
          (t) =>
            `- ${t.prompt.slice(0, 80)}... (${t.schedule_type}: ${t.schedule_value})`,
        )
        .join('\n');
      sections.push(`\n--- Scheduled tasks ---\n${formatted}`);
    }
  } catch {
    // DB not initialized, skip
  }

  // 6. Message bus items pending for this group
  const busQueuePath = path.join(
    DATA_DIR,
    'bus',
    'agents',
    groupFolder,
    'queue.json',
  );
  if (fs.existsSync(busQueuePath)) {
    try {
      const queue = JSON.parse(fs.readFileSync(busQueuePath, 'utf-8'));
      if (Array.isArray(queue) && queue.length > 0) {
        const formatted = queue
          .slice(0, 5)
          .map(
            (item: { from: string; finding: string }) =>
              `- From ${item.from}: ${(item.finding || '').slice(0, 150)}`,
          )
          .join('\n');
        sections.push(
          `\n--- Pending items from other agents ---\n${formatted}`,
        );
      }
    } catch {
      // Malformed queue, skip
    }
  }

  // 7. Classified events (from message bus)
  if (fs.existsSync(busQueuePath)) {
    try {
      const queue = JSON.parse(fs.readFileSync(busQueuePath, 'utf-8'));
      const classified = queue.filter(
        (m: { topic: string }) => m.topic === 'classified_event',
      );
      if (classified.length > 0) {
        const formatted = classified
          .slice(0, 10)
          .map(
            (e: {
              payload?: {
                classification?: { urgency?: string; summary?: string };
              };
              from?: string;
              finding?: string;
            }) =>
              `[${e.payload?.classification?.urgency || 'medium'}] ${e.payload?.classification?.summary || e.finding || 'No summary'} (from: ${e.from || 'unknown'})`,
          )
          .join('\n');
        sections.push(`\n--- Recent Events (classified) ---\n${formatted}`);
      }
    } catch {
      // Already read above or malformed, skip
    }
  }

  // Assemble and truncate
  let packet = sections.join('\n');
  if (packet.length > CONTEXT_PACKET_MAX_SIZE) {
    packet = packet.slice(0, CONTEXT_PACKET_MAX_SIZE) + '\n[...truncated]';
  }

  return packet;
}

/**
 * Write the context packet + bus queue to the group's IPC directory
 * so the container can read them at startup.
 */
export function writeContextPacket(
  groupFolder: string,
  isMain: boolean,
  ipcDir: string,
): void {
  const packet = assembleContextPacket(groupFolder, isMain);
  const packetPath = path.join(ipcDir, 'context-packet.txt');
  fs.writeFileSync(packetPath, packet);

  // Also copy bus queue if it exists, then clear it (agent will process)
  const busQueueSrc = path.join(
    DATA_DIR,
    'bus',
    'agents',
    groupFolder,
    'queue.json',
  );
  const busQueueDst = path.join(ipcDir, 'bus-queue.json');
  if (fs.existsSync(busQueueSrc)) {
    fs.copyFileSync(busQueueSrc, busQueueDst);
    fs.writeFileSync(busQueueSrc, '[]');
  }
}
