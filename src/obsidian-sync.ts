/**
 * Obsidian vault sync — renders exocortex content into an existing vvault (PARA structure).
 *
 * Maps exocortex content into the vault's existing folder structure:
 *   3. Resources/Exocortex/Fleeting/   ← from exocortex fleeting/
 *   3. Resources/Exocortex/Notes/      ← from exocortex notes/
 *   3. Resources/Exocortex/Plans/      ← from exocortex plans/
 *   1. Projects/AI Assistant/          ← from nanoclaw project
 *   1. Projects/AI Finance/            ← from onto project
 *   0a. Daily Notes/YYYY/...           ← appended exocortex section
 *   Home.md, Tags.md, soul.md         ← vault root
 *
 * Uses filename-only wiki-links (Obsidian resolves by filename).
 * Daily notes: appends delimited section, never creates new files.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from './logger.js';

function resolvePath(p: string): string {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

// --- Vault layout ---

interface VaultLayout {
  fleeting: string;   // "3. Resources/Exocortex/Fleeting"
  notes: string;      // "3. Resources/Exocortex/Notes"
  plans: string;      // "3. Resources/Exocortex/Plans"
  dailyNotes: string; // "0a. Daily Notes"
}

const VAULT_LAYOUT: VaultLayout = {
  fleeting: '3. Resources/Exocortex/Fleeting',
  notes: '3. Resources/Exocortex/Notes',
  plans: '3. Resources/Exocortex/Plans',
  dailyNotes: '0a. Daily Notes',
};

/** Map exocortex project names to vvault PARA folder paths. */
const PROJECT_VAULT_MAP: Record<string, string> = {
  nanoclaw: '1. Projects/AI Assistant',
  onto: '1. Projects/AI Finance',
};

// Exported for tests
export { VAULT_LAYOUT, PROJECT_VAULT_MAP };

/** Frontmatter parsed from a fleeting/permanent note file. */
export interface NoteFrontmatter {
  type: string;
  status?: string;
  project?: string;
  source?: string;
  tags?: string[];
  created?: string;
  source_fleeting?: string;
  [key: string]: unknown;
}

/** Parsed note file — frontmatter + body. */
export interface NoteFile {
  frontmatter: NoteFrontmatter;
  body: string;
  filename: string;
}

/**
 * Parse YAML frontmatter from a markdown file.
 * Returns { frontmatter, body } or null if no frontmatter.
 */
export function parseFrontmatter(content: string): {
  frontmatter: NoteFrontmatter;
  body: string;
} | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;

  const yamlBlock = match[1];
  const body = match[2];
  const frontmatter: NoteFrontmatter = { type: '' };

  for (const line of yamlBlock.split('\n')) {
    const kvMatch = line.match(/^(\w[\w_]*)\s*:\s*(.*)$/);
    if (!kvMatch) continue;
    const [, key, rawValue] = kvMatch;
    let value: unknown = rawValue.trim();

    // Parse arrays: [tag1, tag2]
    if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
      value = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    // Unquote strings
    if (typeof value === 'string' && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }

    (frontmatter as Record<string, unknown>)[key] = value;
  }

  return { frontmatter, body };
}

/**
 * Serialize frontmatter + body back to markdown with YAML block.
 */
export function serializeFrontmatter(
  frontmatter: NoteFrontmatter,
  body: string,
): string {
  const lines: string[] = ['---'];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.join(', ')}]`);
    } else {
      const strVal = String(value);
      // Quote strings that contain special YAML characters
      if (strVal.includes(':') || strVal.includes('#') || strVal.includes("'")) {
        lines.push(`${key}: "${strVal}"`);
      } else {
        lines.push(`${key}: ${strVal}`);
      }
    }
  }
  lines.push('---');
  return lines.join('\n') + '\n' + body;
}

/**
 * Read all note files from a directory. Returns parsed notes.
 */
export function readNoteFiles(dir: string): NoteFile[] {
  if (!fs.existsSync(dir)) return [];

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort();

  const notes: NoteFile[] = [];
  for (const filename of files) {
    const content = fs.readFileSync(path.join(dir, filename), 'utf-8');
    const parsed = parseFrontmatter(content);
    if (parsed) {
      notes.push({ frontmatter: parsed.frontmatter, body: parsed.body, filename });
    }
  }
  return notes;
}

/**
 * Render a note file to Obsidian vault format.
 * Adds Obsidian-specific frontmatter adjustments and processes links.
 */
function renderNoteToVault(note: NoteFile): string {
  const fm = { ...note.frontmatter };

  // Convert tags array to Obsidian format (strip leading #)
  if (fm.tags && Array.isArray(fm.tags)) {
    fm.tags = fm.tags.map((t) => (t.startsWith('#') ? t.slice(1) : t));
  }

  return serializeFrontmatter(fm, note.body);
}

/**
 * Sync a directory of note files to the vault, preserving structure.
 */
function syncNoteDir(
  sourceDir: string,
  vaultDir: string,
  stats: SyncStats,
): void {
  if (!fs.existsSync(sourceDir)) return;

  fs.mkdirSync(vaultDir, { recursive: true });

  const notes = readNoteFiles(sourceDir);
  const vaultFiles = new Set(
    fs.readdirSync(vaultDir).filter((f) => f.endsWith('.md')),
  );

  for (const note of notes) {
    const rendered = renderNoteToVault(note);
    const targetPath = path.join(vaultDir, note.filename);
    const existing = vaultFiles.has(note.filename)
      ? fs.readFileSync(targetPath, 'utf-8')
      : null;

    if (existing !== rendered) {
      fs.writeFileSync(targetPath, rendered);
      stats.written++;
    } else {
      stats.unchanged++;
    }
    vaultFiles.delete(note.filename);
  }

  // Remove vault files that no longer exist in source
  for (const orphan of vaultFiles) {
    fs.unlinkSync(path.join(vaultDir, orphan));
    stats.removed++;
  }
}

/**
 * Copy a plain markdown file to the vault (for files like goals.md, todo.md).
 * Only writes if content changed.
 */
function syncPlainFile(
  sourcePath: string,
  vaultPath: string,
  stats: SyncStats,
): void {
  if (!fs.existsSync(sourcePath)) return;

  fs.mkdirSync(path.dirname(vaultPath), { recursive: true });
  const content = fs.readFileSync(sourcePath, 'utf-8');
  const existing = fs.existsSync(vaultPath)
    ? fs.readFileSync(vaultPath, 'utf-8')
    : null;

  if (existing !== content) {
    fs.writeFileSync(vaultPath, content);
    stats.written++;
  } else {
    stats.unchanged++;
  }
}

export interface SyncStats {
  written: number;
  unchanged: number;
  removed: number;
}

/**
 * Discover projects in the exocortex.
 * Projects are directories under projects/ (excluding _template).
 * Also includes nanoclaw/ as a special project.
 */
function discoverProjects(exocortexPath: string): string[] {
  const projects: string[] = ['nanoclaw'];

  const projectsDir = path.join(exocortexPath, 'projects');
  if (fs.existsSync(projectsDir)) {
    const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== '_template') {
        projects.push(`projects/${entry.name}`);
      }
    }
  }

  return projects;
}

/**
 * Sync a directory of plain markdown files to the vault.
 * Copies all .md files, removes orphans. Like syncNoteDir but without frontmatter rendering.
 */
function syncPlainDir(
  sourceDir: string,
  vaultDir: string,
  stats: SyncStats,
): void {
  if (!fs.existsSync(sourceDir)) return;

  fs.mkdirSync(vaultDir, { recursive: true });
  const files = fs.readdirSync(sourceDir).filter((f) => f.endsWith('.md'));
  const vaultFiles = new Set(
    fs.existsSync(vaultDir)
      ? fs.readdirSync(vaultDir).filter((f) => f.endsWith('.md'))
      : [],
  );

  for (const file of files) {
    syncPlainFile(path.join(sourceDir, file), path.join(vaultDir, file), stats);
    vaultFiles.delete(file);
  }

  for (const orphan of vaultFiles) {
    fs.unlinkSync(path.join(vaultDir, orphan));
    stats.removed++;
  }
}

/** Extract YYYY-MM-DD date from a fleeting note filename. */
function extractDateFromFilename(filename: string): string | null {
  const match = filename.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

/** Strip .md extension for wiki-link references. */
function stripMd(filename: string): string {
  return filename.replace(/\.md$/, '');
}

/** Resolve vault path for a project name. Uses PROJECT_VAULT_MAP or falls back to Projects/{name}. */
function resolveProjectVaultDir(vault: string, projectName: string): string {
  const mapped = PROJECT_VAULT_MAP[projectName];
  if (mapped) return path.join(vault, mapped);
  return path.join(vault, '1. Projects', projectName);
}

/** Get the display name for a project in wiki-links. */
function projectOverviewLink(projectName: string): string {
  const mapped = PROJECT_VAULT_MAP[projectName];
  if (mapped) {
    // Use filename-only link — Obsidian resolves by filename
    return `[[overview|${projectName} overview]]`;
  }
  return `[[overview|${projectName} overview]]`;
}

// --- Exocortex section markers for daily notes ---
const EXOCORTEX_START = '<!-- exocortex-start -->';
const EXOCORTEX_END = '<!-- exocortex-end -->';

/**
 * Find an existing daily note file for a given date.
 * Scans 0a. Daily Notes/YYYY/MM-Month/ for files matching YYYY-MM-DD-*.md
 */
function findDailyNoteFile(vault: string, date: string): string | null {
  const [year, monthNum] = date.split('-');
  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const monthName = monthNames[parseInt(monthNum, 10) - 1];
  const monthDir = path.join(vault, VAULT_LAYOUT.dailyNotes, year, `${monthNum}-${monthName}`);

  if (!fs.existsSync(monthDir)) return null;

  const files = fs.readdirSync(monthDir);
  // Match files starting with the date: YYYY-MM-DD-DayName.md or YYYY-MM-DD.md
  const match = files.find((f) => f.startsWith(date) && f.endsWith('.md'));
  return match ? path.join(monthDir, match) : null;
}

/**
 * Build the exocortex section content for a daily note.
 */
function buildExocortexSection(
  fleeting: NoteFile[],
  permanent: NoteFile[],
): string {
  const lines: string[] = [
    EXOCORTEX_START,
    '## Exocortex',
    '',
  ];

  // Captured
  if (fleeting.length > 0) {
    lines.push('### Captured', '');
    for (const note of fleeting) {
      const status = note.frontmatter.status || 'active';
      const project = note.frontmatter.project || 'general';
      const source = note.frontmatter.source ? `, ${note.frontmatter.source}` : '';
      lines.push(
        `- [[${stripMd(note.filename)}]] (${status}, ${project}${source})`,
      );
    }
    lines.push('');
  }

  // Triaged (incorporated/retired)
  const triaged = fleeting.filter(
    (n) => n.frontmatter.status === 'incorporated' || n.frontmatter.status === 'retired',
  );
  if (triaged.length > 0) {
    lines.push('### Triaged', '');
    for (const note of triaged) {
      const incorporatedInto = note.frontmatter.incorporated_into;
      if (incorporatedInto && Array.isArray(incorporatedInto)) {
        for (const target of incorporatedInto) {
          lines.push(
            `- [[${stripMd(note.filename)}]] → ${target}`,
          );
        }
      } else if (note.frontmatter.status === 'retired') {
        const reason = note.frontmatter.retired_reason || '';
        lines.push(
          `- [[${stripMd(note.filename)}]] — retired${reason ? ': ' + reason : ''}`,
        );
      }
    }
    lines.push('');
  }

  // Notes Created
  if (permanent.length > 0) {
    lines.push('### Notes Created', '');
    for (const note of permanent) {
      lines.push(`- [[${stripMd(note.filename)}]]`);
    }
    lines.push('');
  }

  // Project Activity
  const projectCounts = new Map<string, { captured: number; triaged: number }>();
  for (const note of fleeting) {
    const project = note.frontmatter.project || 'general';
    if (!projectCounts.has(project)) projectCounts.set(project, { captured: 0, triaged: 0 });
    projectCounts.get(project)!.captured++;
    if (note.frontmatter.status === 'incorporated' || note.frontmatter.status === 'retired') {
      projectCounts.get(project)!.triaged++;
    }
  }
  if (projectCounts.size > 0) {
    lines.push('### Project Activity', '');
    for (const [project, counts] of projectCounts) {
      lines.push(
        `- **${project}**: ${counts.captured} capture${counts.captured !== 1 ? 's' : ''}${counts.triaged > 0 ? `, ${counts.triaged} triaged` : ''}`,
      );
    }
    lines.push('');
  }

  lines.push(EXOCORTEX_END);
  return lines.join('\n');
}

/**
 * Generate daily notes — appends exocortex section to existing daily notes.
 * Does NOT create new daily note files (Obsidian's daily note plugin handles creation).
 * Groups fleeting notes by date and includes triaged/created permanent notes.
 */
export function generateDailyNotes(
  exo: string,
  vault: string,
  stats: SyncStats,
): void {
  const fleetingNotes = readNoteFiles(path.join(exo, 'fleeting'));
  const permanentNotes = readNoteFiles(path.join(exo, 'notes'));

  if (fleetingNotes.length === 0 && permanentNotes.length === 0) return;

  // Group fleeting notes by date
  const fleetingByDate = new Map<string, NoteFile[]>();
  for (const note of fleetingNotes) {
    const date = extractDateFromFilename(note.filename);
    if (!date) continue;
    if (!fleetingByDate.has(date)) fleetingByDate.set(date, []);
    fleetingByDate.get(date)!.push(note);
  }

  // Group permanent notes by created date
  const permanentByDate = new Map<string, NoteFile[]>();
  for (const note of permanentNotes) {
    const created = note.frontmatter.created;
    if (!created) continue;
    const date = String(created).slice(0, 10);
    if (!permanentByDate.has(date)) permanentByDate.set(date, []);
    permanentByDate.get(date)!.push(note);
  }

  // Collect all dates
  const allDates = new Set([...fleetingByDate.keys(), ...permanentByDate.keys()]);

  for (const date of allDates) {
    const fleeting = fleetingByDate.get(date) || [];
    const permanent = permanentByDate.get(date) || [];

    const dailyNotePath = findDailyNoteFile(vault, date);
    if (!dailyNotePath) {
      // No existing daily note for this date — skip (don't create)
      continue;
    }

    const existingContent = fs.readFileSync(dailyNotePath, 'utf-8');
    const section = buildExocortexSection(fleeting, permanent);

    // Replace existing exocortex section or append
    let newContent: string;
    const startIdx = existingContent.indexOf(EXOCORTEX_START);
    const endIdx = existingContent.indexOf(EXOCORTEX_END);

    if (startIdx !== -1 && endIdx !== -1) {
      // Replace existing section
      newContent =
        existingContent.slice(0, startIdx) +
        section +
        existingContent.slice(endIdx + EXOCORTEX_END.length);
    } else {
      // Append section
      const trimmed = existingContent.trimEnd();
      newContent = trimmed + '\n\n' + section + '\n';
    }

    if (existingContent !== newContent) {
      fs.writeFileSync(dailyNotePath, newContent);
      stats.written++;
    } else {
      stats.unchanged++;
    }
  }
}

/**
 * Generate the Home.md dashboard — landing page for the vault.
 * Uses filename-only wiki-links.
 */
export function generateDashboard(
  exo: string,
  vault: string,
  stats: SyncStats,
): void {
  const fleetingNotes = readNoteFiles(path.join(exo, 'fleeting'));
  const permanentNotes = readNoteFiles(path.join(exo, 'notes'));
  const projects = discoverProjects(exo);

  const now = new Date();
  const syncTime = now.toLocaleString('en-US', {
    month: 'numeric',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  const today = now.toISOString().slice(0, 10);

  // Count by status
  let active = 0;
  let incorporated = 0;
  let retired = 0;
  for (const note of fleetingNotes) {
    switch (note.frontmatter.status) {
      case 'incorporated':
        incorporated++;
        break;
      case 'retired':
        retired++;
        break;
      default:
        active++;
    }
  }

  // Count tags
  const tagCounts = new Map<string, number>();
  for (const note of [...fleetingNotes, ...permanentNotes]) {
    if (note.frontmatter.tags && Array.isArray(note.frontmatter.tags)) {
      for (const tag of note.frontmatter.tags) {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      }
    }
  }

  // Today's captures
  const todayCaptures = fleetingNotes.filter((n) =>
    n.filename.startsWith(today),
  );
  const todayTriaged = todayCaptures.filter(
    (n) => n.frontmatter.status === 'incorporated' || n.frontmatter.status === 'retired',
  );
  const todayPermanent = permanentNotes.filter(
    (n) => String(n.frontmatter.created || '').startsWith(today),
  );

  // Project note counts
  const projectNoteCounts = new Map<
    string,
    { fleeting: number; permanent: number; todos: number }
  >();
  for (const project of projects) {
    const projectName = project.includes('/') ? project.split('/').pop()! : project;
    const fleetingCount = fleetingNotes.filter(
      (n) => n.frontmatter.project === projectName,
    ).length;
    const permanentCount = permanentNotes.filter(
      (n) => n.frontmatter.project === projectName,
    ).length;

    // Count open todos
    const todoPath = path.join(exo, project, 'todo.md');
    let todoCount = 0;
    if (fs.existsSync(todoPath)) {
      const todoContent = fs.readFileSync(todoPath, 'utf-8');
      todoCount = (todoContent.match(/^- \[ \]/gm) || []).length;
    }

    projectNoteCounts.set(projectName, {
      fleeting: fleetingCount,
      permanent: permanentCount,
      todos: todoCount,
    });
  }

  // Recent notes (last 5 across all types) — filename-only links
  const allNotes: Array<{ link: string; status?: string }> = [];
  for (const note of fleetingNotes) {
    allNotes.push({
      link: `[[${stripMd(note.filename)}]]`,
      status: note.frontmatter.status,
    });
  }
  for (const note of permanentNotes) {
    allNotes.push({
      link: `[[${stripMd(note.filename)}]]`,
      status: 'permanent',
    });
  }
  const recentNotes = allNotes.reverse().slice(0, 5);

  // Build dashboard
  const lines: string[] = [
    '# Exocortex Dashboard',
    `*Last synced: ${syncTime}*`,
    '',
  ];

  // Today section
  lines.push('## Today');
  if (todayCaptures.length > 0 || todayPermanent.length > 0) {
    const parts: string[] = [];
    if (todayCaptures.length > 0) parts.push(`${todayCaptures.length} capture${todayCaptures.length !== 1 ? 's' : ''}`);
    if (todayTriaged.length > 0) parts.push(`${todayTriaged.length} triaged`);
    if (todayPermanent.length > 0) parts.push(`${todayPermanent.length} permanent note${todayPermanent.length !== 1 ? 's' : ''} created`);
    lines.push(`- ${parts.join(', ')}`);
  } else {
    lines.push('- No activity today');
  }
  lines.push('');

  // Active Projects
  lines.push('## Active Projects');
  for (const [projectName, counts] of projectNoteCounts) {
    const noteParts: string[] = [];
    if (counts.fleeting > 0) noteParts.push(`${counts.fleeting} note${counts.fleeting !== 1 ? 's' : ''}`);
    if (counts.todos > 0) noteParts.push(`${counts.todos} open todo${counts.todos !== 1 ? 's' : ''}`);
    lines.push(
      `- ${projectOverviewLink(projectName)} — ${noteParts.length > 0 ? noteParts.join(', ') : 'no notes yet'}`,
    );
  }
  lines.push('');

  // Recent Notes
  lines.push('## Recent Notes');
  for (const note of recentNotes) {
    const statusStr = note.status && note.status !== 'active' ? ` (${note.status})` : '';
    lines.push(`- ${note.link}${statusStr}`);
  }
  lines.push('');

  // Inbox Pressure
  lines.push('## Inbox Pressure');
  lines.push(`- **Active fleeting notes:** ${active}`);
  lines.push(`- **Incorporated:** ${incorporated}`);
  lines.push(`- **Retired:** ${retired}`);
  lines.push('');

  // Tag Cloud
  if (tagCounts.size > 0) {
    lines.push('## Tag Cloud');
    const sortedTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]);
    lines.push(sortedTags.map(([tag, count]) => `${tag} (${count})`).join(' — '));
    lines.push('');
  }

  lines.push('---');
  lines.push('*[[soul]] — [[Tags]]*');
  lines.push('');

  const content = lines.join('\n');
  const targetPath = path.join(vault, 'Home.md');
  const existing = fs.existsSync(targetPath)
    ? fs.readFileSync(targetPath, 'utf-8')
    : null;

  if (existing !== content) {
    fs.writeFileSync(targetPath, content);
    stats.written++;
  } else {
    stats.unchanged++;
  }
}

/**
 * Enhance project overviews with computed vault links.
 * Uses filename-only wiki-links and resolves project vault paths via PROJECT_VAULT_MAP.
 */
export function enhanceProjectOverviews(
  exo: string,
  vault: string,
  stats: SyncStats,
): void {
  const fleetingNotes = readNoteFiles(path.join(exo, 'fleeting'));
  const permanentNotes = readNoteFiles(path.join(exo, 'notes'));
  const projects = discoverProjects(exo);

  // Read plans if they exist
  const plansDir = path.join(exo, 'plans');
  const planFiles: NoteFile[] = [];
  if (fs.existsSync(plansDir)) {
    const files = fs.readdirSync(plansDir).filter((f) => f.endsWith('.md'));
    for (const filename of files) {
      const content = fs.readFileSync(path.join(plansDir, filename), 'utf-8');
      const parsed = parseFrontmatter(content);
      if (parsed) {
        planFiles.push({ frontmatter: parsed.frontmatter, body: parsed.body, filename });
      } else {
        planFiles.push({ frontmatter: { type: 'plan' }, body: content, filename });
      }
    }
  }

  for (const project of projects) {
    const projectName = project.includes('/') ? project.split('/').pop()! : project;
    const overviewSource = path.join(exo, project, 'overview.md');
    const vaultProjectDir = resolveProjectVaultDir(vault, projectName);
    const overviewVault = path.join(vaultProjectDir, 'overview.md');

    if (!fs.existsSync(overviewSource)) continue;

    const sourceContent = fs.readFileSync(overviewSource, 'utf-8');

    // Find related notes
    const relatedFleeting = fleetingNotes
      .filter((n) => n.frontmatter.project === projectName)
      .reverse()
      .slice(0, 10);

    const relatedPermanent = permanentNotes.filter(
      (n) => n.frontmatter.project === projectName,
    );

    const relatedPlans = planFiles.filter(
      (n) => n.frontmatter.project === projectName,
    );

    // Build computed section — filename-only links
    const computed: string[] = [
      '',
      '---',
      '## Vault Links (computed)',
      '',
    ];

    if (relatedFleeting.length > 0) {
      computed.push('### Recent Fleeting Notes', '');
      for (const note of relatedFleeting) {
        const status = note.frontmatter.status || 'active';
        computed.push(`- [[${stripMd(note.filename)}]] (${status})`);
      }
      computed.push('');
    }

    if (relatedPermanent.length > 0) {
      computed.push('### Permanent Notes', '');
      for (const note of relatedPermanent) {
        computed.push(`- [[${stripMd(note.filename)}]]`);
      }
      computed.push('');
    }

    if (relatedPlans.length > 0) {
      computed.push('### Plans', '');
      for (const note of relatedPlans) {
        computed.push(`- [[${stripMd(note.filename)}]]`);
      }
      computed.push('');
    }

    // Related project files — use filename with display alias for clarity
    const relatedFiles: string[] = [];
    for (const file of ['goals', 'status', 'todo', 'connections']) {
      if (fs.existsSync(path.join(exo, project, `${file}.md`))) {
        relatedFiles.push(`[[${file}|${projectName} ${file}]]`);
      }
    }
    if (relatedFiles.length > 0) {
      computed.push('### Related', '');
      for (const link of relatedFiles) {
        computed.push(`- ${link}`);
      }
      computed.push('');
    }

    const enhanced = sourceContent + computed.join('\n');

    fs.mkdirSync(path.dirname(overviewVault), { recursive: true });
    const existing = fs.existsSync(overviewVault)
      ? fs.readFileSync(overviewVault, 'utf-8')
      : null;

    if (existing !== enhanced) {
      fs.writeFileSync(overviewVault, enhanced);
    }
  }
}

/** Project files we sync to the vault. */
const PROJECT_FILES = [
  'goals.md',
  'overview.md',
  'status.md',
  'todo.md',
  'connections.md',
];

/**
 * Main sync function. Renders exocortex content into existing vvault PARA structure.
 */
export function syncToVault(
  exocortexPath: string,
  vaultPath: string,
): SyncStats {
  const exo = resolvePath(exocortexPath);
  const vault = resolvePath(vaultPath);

  const stats: SyncStats = { written: 0, unchanged: 0, removed: 0 };

  // Ensure vault root exists
  fs.mkdirSync(vault, { recursive: true });

  // 1. Sync fleeting notes → 3. Resources/Exocortex/Fleeting/
  syncNoteDir(path.join(exo, 'fleeting'), path.join(vault, VAULT_LAYOUT.fleeting), stats);

  // 2. Sync permanent notes → 3. Resources/Exocortex/Notes/
  syncNoteDir(path.join(exo, 'notes'), path.join(vault, VAULT_LAYOUT.notes), stats);

  // 3. Sync projects → mapped PARA folders
  const projects = discoverProjects(exo);
  for (const project of projects) {
    const projectDir = path.join(exo, project);
    const projectName = project.includes('/')
      ? project.split('/').pop()!
      : project;
    const vaultProjectDir = resolveProjectVaultDir(vault, projectName);

    for (const file of PROJECT_FILES) {
      syncPlainFile(
        path.join(projectDir, file),
        path.join(vaultProjectDir, file),
        stats,
      );
    }

    // Also sync project-level fleeting and notes if they exist
    syncNoteDir(
      path.join(projectDir, 'fleeting'),
      path.join(vaultProjectDir, 'fleeting'),
      stats,
    );
    syncNoteDir(
      path.join(projectDir, 'notes'),
      path.join(vaultProjectDir, 'notes'),
      stats,
    );
  }

  // 4. Sync top-level files to vault root
  syncPlainFile(path.join(exo, 'soul.md'), path.join(vault, 'soul.md'), stats);
  syncPlainFile(path.join(exo, 'tags.md'), path.join(vault, 'Tags.md'), stats);

  // 5. Sync plans → 3. Resources/Exocortex/Plans/
  syncPlainDir(path.join(exo, 'plans'), path.join(vault, VAULT_LAYOUT.plans), stats);

  // 6. Enhance project overviews with computed vault links
  enhanceProjectOverviews(exo, vault, stats);

  // 7. Generate daily notes (append to existing)
  generateDailyNotes(exo, vault, stats);

  // 8. Generate dashboard
  generateDashboard(exo, vault, stats);

  return stats;
}

/**
 * Run a single sync cycle with logging.
 */
export function runObsidianSync(
  exocortexPath: string,
  vaultPath: string,
): void {
  try {
    const stats = syncToVault(exocortexPath, vaultPath);
    if (stats.written > 0 || stats.removed > 0) {
      logger.info(
        { written: stats.written, removed: stats.removed, unchanged: stats.unchanged },
        'Obsidian vault sync completed',
      );
    } else {
      logger.debug('Obsidian vault sync: no changes');
    }
  } catch (err) {
    logger.error({ err }, 'Obsidian vault sync failed');
  }
}

/**
 * Start the periodic Obsidian vault sync.
 */
export function startObsidianSync(
  exocortexPath: string,
  vaultPath: string,
  intervalMs: number,
): void {
  logger.info(
    { intervalMs, exocortexPath, vaultPath },
    'Starting Obsidian vault sync loop',
  );

  const run = () => runObsidianSync(exocortexPath, vaultPath);
  run();
  setInterval(run, intervalMs);
}
