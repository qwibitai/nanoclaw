import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { VaultUtility } from '../vault/vault-utility.js';

interface StudySessionEntry {
  type: 'quiz' | 'qa' | 'summary' | 'writing' | 'study';
  course?: string;
  topic: string;
  duration?: string;
  result?: string;
}

export class StudentProfile {
  constructor(private readonly vault: VaultUtility) {}

  async logStudySession(entry: StudySessionEntry): Promise<void> {
    const logPath = 'profile/study-log.md';
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toTimeString().slice(0, 5);

    const parts: string[] = [`- **${entry.type}** — ${entry.topic}`];
    if (entry.course) parts.push(`course: ${entry.course}`);
    if (entry.duration) parts.push(`duration: ${entry.duration}`);
    if (entry.result) parts.push(`result: ${entry.result}`);
    const line = `${parts.join(' | ')} — ${dateStr} ${timeStr}`;

    const note = await this.vault.readNote(logPath);
    const existing = note ? note.content : '# Study Log\n';
    const updated = existing.trimEnd() + '\n' + line + '\n';

    const fullPath = join(
      (this.vault as unknown as { vaultDir: string }).vaultDir,
      logPath,
    );
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, updated, 'utf-8');
  }

  async updateKnowledgeMap(
    topic: string,
    course: string,
    confidence: number,
  ): Promise<void> {
    const mapPath = 'profile/knowledge-map.md';
    const dateStr = new Date().toISOString().slice(0, 10);
    const newLine = `- **${topic}** (${course}) — confidence: ${confidence} — updated: ${dateStr}`;

    const note = await this.vault.readNote(mapPath);
    const existing = note ? note.content : '# Knowledge Map\n';

    const escapedTopic = topic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const topicRegex = new RegExp(`^- \\*\\*${escapedTopic}\\*\\*.*$`, 'm');

    let updated: string;
    if (topicRegex.test(existing)) {
      updated = existing.replace(topicRegex, newLine);
    } else {
      updated = existing.trimEnd() + '\n' + newLine + '\n';
    }

    const fullPath = join(
      (this.vault as unknown as { vaultDir: string }).vaultDir,
      mapPath,
    );
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, updated, 'utf-8');
  }

  async addCourse(
    courseCode: string,
    courseName: string,
    semester: number,
  ): Promise<void> {
    const profilePath = 'profile/student-profile.md';
    const courseEntry = `- **${courseCode}** — ${courseName} (Semester ${semester})`;

    const note = await this.vault.readNote(profilePath);
    const existing = note
      ? note.content
      : '# Student Profile\n\n## Active Courses\n';

    const heading = '## Active Courses';
    let updated: string;
    if (existing.includes(heading)) {
      const insertPos = existing.indexOf(heading) + heading.length;
      updated =
        existing.slice(0, insertPos) +
        '\n' +
        courseEntry +
        existing.slice(insertPos);
    } else {
      updated =
        existing.trimEnd() + '\n\n' + heading + '\n' + courseEntry + '\n';
    }

    const fullPath = join(
      (this.vault as unknown as { vaultDir: string }).vaultDir,
      profilePath,
    );
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, updated, 'utf-8');
  }
}
