import fs from 'node:fs';
import path from 'node:path';

import {
  type ProjectRegistry,
  type ProjectRegistryEntry,
  validateProjectRegistry,
} from './symphony-routing.js';

const NOTION_API_URL = process.env.NOTION_API_URL || 'https://api.notion.com/v1';
const NOTION_VERSION = process.env.NOTION_VERSION || '2022-06-28';

type NotionRichText = {
  plain_text?: string;
};

type NotionProperty =
  | { type: 'title'; title?: NotionRichText[] }
  | { type: 'rich_text'; rich_text?: NotionRichText[] }
  | { type: 'url'; url?: string | null }
  | { type: 'checkbox'; checkbox?: boolean }
  | { type: 'multi_select'; multi_select?: Array<{ name: string }> }
  | { type: 'select'; select?: { name: string } | null };

type NotionDatabasePage = {
  id: string;
  url: string;
  properties: Record<string, NotionProperty | undefined>;
};

function requireNotionToken(): string {
  const token = process.env.NOTION_TOKEN || process.env.NOTION_API_KEY || '';
  if (!token) {
    throw new Error('Missing NOTION_TOKEN or NOTION_API_KEY.');
  }
  return token;
}

function propertyOrThrow(
  page: NotionDatabasePage,
  propertyName: string,
): NotionProperty {
  const property = page.properties[propertyName];
  if (!property) {
    throw new Error(`Notion registry page ${page.id} is missing property "${propertyName}".`);
  }
  return property;
}

function richTextToString(items: NotionRichText[] | undefined): string {
  return (items || []).map((item) => item.plain_text || '').join('').trim();
}

function readStringProperty(page: NotionDatabasePage, propertyName: string): string {
  const property = propertyOrThrow(page, propertyName);
  switch (property.type) {
    case 'title': {
      const value = richTextToString(property.title);
      if (!value) break;
      return value;
    }
    case 'rich_text': {
      const value = richTextToString(property.rich_text);
      if (!value) break;
      return value;
    }
    case 'url':
      if (property.url) return property.url.trim();
      break;
    case 'select':
      if (property.select?.name) return property.select.name.trim();
      break;
  }

  throw new Error(
    `Notion registry page ${page.id} property "${propertyName}" does not contain a non-empty string value.`,
  );
}

function readCheckboxProperty(page: NotionDatabasePage, propertyName: string): boolean {
  const property = propertyOrThrow(page, propertyName);
  if (property.type !== 'checkbox') {
    throw new Error(
      `Notion registry page ${page.id} property "${propertyName}" must be a checkbox.`,
    );
  }
  return Boolean(property.checkbox);
}

function readMultiSelectProperty(
  page: NotionDatabasePage,
  propertyName: string,
): string[] {
  const property = propertyOrThrow(page, propertyName);
  if (property.type !== 'multi_select') {
    throw new Error(
      `Notion registry page ${page.id} property "${propertyName}" must be a multi-select.`,
    );
  }
  const values = (property.multi_select || [])
    .map((option) => option.name.trim())
    .filter(Boolean);
  if (!values.length) {
    throw new Error(
      `Notion registry page ${page.id} property "${propertyName}" must include at least one option.`,
    );
  }
  return values;
}

function readSelectProperty(page: NotionDatabasePage, propertyName: string): string {
  const property = propertyOrThrow(page, propertyName);
  if (property.type !== 'select' || !property.select?.name?.trim()) {
    throw new Error(
      `Notion registry page ${page.id} property "${propertyName}" must be a non-empty select.`,
    );
  }
  return property.select.name.trim();
}

async function notionRequest<T>(route: string, body: unknown): Promise<T> {
  const response = await fetch(`${NOTION_API_URL}${route}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${requireNotionToken()}`,
      'Content-Type': 'application/json',
      'Notion-Version': NOTION_VERSION,
      'User-Agent': 'nanoclaw-symphony-registry-sync',
    },
    body: JSON.stringify(body),
  });

  const payload = (await response.json()) as T & { message?: string };
  if (!response.ok) {
    throw new Error(
      `Notion API request failed: ${response.status} ${response.statusText}\n${JSON.stringify(
        payload,
        null,
        2,
      )}`,
    );
  }

  return payload;
}

function pageToRegistryEntry(page: NotionDatabasePage): ProjectRegistryEntry {
  return {
    projectKey: readStringProperty(page, 'Project Key'),
    displayName: readStringProperty(page, 'Name'),
    linearProject: readStringProperty(page, 'Linear Project'),
    notionRoot: readStringProperty(page, 'Notion Root'),
    githubRepo: readStringProperty(page, 'GitHub Repo'),
    symphonyEnabled: readCheckboxProperty(page, 'Symphony Enabled'),
    allowedBackends: readMultiSelectProperty(page, 'Allowed Backends') as ProjectRegistryEntry['allowedBackends'],
    defaultBackend: readSelectProperty(page, 'Default Backend') as ProjectRegistryEntry['defaultBackend'],
    workClassesSupported: readMultiSelectProperty(page, 'Work Classes Supported') as ProjectRegistryEntry['workClassesSupported'],
    secretScope: readStringProperty(page, 'Secret Scope'),
    workspaceRoot: readStringProperty(page, 'Workspace Root'),
    readyPolicy: readStringProperty(page, 'Ready Policy'),
  };
}

export async function fetchProjectRegistryFromNotion(
  databaseId: string,
): Promise<ProjectRegistry> {
  const projects: ProjectRegistryEntry[] = [];
  let cursor: string | undefined;

  do {
    const payload = await notionRequest<{
      results: NotionDatabasePage[];
      has_more: boolean;
      next_cursor: string | null;
    }>(`/databases/${databaseId}/query`, {
      page_size: 100,
      start_cursor: cursor,
    });

    for (const page of payload.results) {
      projects.push(pageToRegistryEntry(page));
    }

    cursor = payload.has_more ? payload.next_cursor || undefined : undefined;
  } while (cursor);

  return validateProjectRegistry({
    schemaVersion: 1,
    projects,
  });
}

export function loadProjectRegistryFromFile(filePath: string): ProjectRegistry {
  return validateProjectRegistry(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

export function writeProjectRegistryCache(
  filePath: string,
  registry: ProjectRegistry,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
}
