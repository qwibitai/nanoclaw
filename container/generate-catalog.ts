import fs from 'fs';
import path from 'path';

export interface CatalogEntry {
  name: string;
  source: string;
  description: string;
  categories: string[];
  path: string;
}

export interface Catalog {
  skills: CatalogEntry[];
}

export interface CategoryConfig {
  defaults: string[];
  overrides: Record<string, string[]>;
}

/**
 * Extract YAML frontmatter from a SKILL.md file.
 * Returns { name, description } or nulls if no frontmatter.
 */
function extractFrontmatter(
  content: string,
): { name: string | null; description: string | null } {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { name: null, description: null };

  const yaml = match[1];
  let name: string | null = null;
  let description: string | null = null;

  for (const line of yaml.split('\n')) {
    const nameMatch = line.match(/^name:\s*(.+)/);
    if (nameMatch) name = nameMatch[1].trim();
    const descMatch = line.match(/^description:\s*(.+)/);
    if (descMatch) description = descMatch[1].trim();
  }

  return { name, description };
}

/**
 * Recursively find all SKILL.md files under a directory.
 */
function findSkillFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findSkillFiles(full));
    } else if (entry.name === 'SKILL.md') {
      results.push(full);
    }
  }
  return results;
}

/**
 * Determine the source string for a skill based on its path relative to the catalog root.
 * - local/* → "local"
 * - plugins/{pluginName}/* → "plugin:{pluginName}"
 */
function determineSource(relativePath: string): string {
  const parts = relativePath.split(path.sep);
  if (parts[0] === 'plugins' && parts.length >= 2) {
    return `plugin:${parts[1]}`;
  }
  return 'local';
}

/**
 * Generate a catalog from all SKILL.md files under catalogDir.
 */
export function generateCatalog(
  catalogDir: string,
  categories: CategoryConfig,
): Catalog {
  const skills: CatalogEntry[] = [];
  const skillFiles = findSkillFiles(catalogDir);

  for (const skillFile of skillFiles) {
    const content = fs.readFileSync(skillFile, 'utf-8');
    const frontmatter = extractFrontmatter(content);
    const skillDir = path.dirname(skillFile);
    const relativePath = path.relative(catalogDir, skillDir);
    const dirName = path.basename(skillDir);

    const name = frontmatter.name || dirName;
    const description = frontmatter.description || '';
    const source = determineSource(relativePath);
    const skillCategories = categories.overrides[name] || categories.defaults;

    // Container path: /skills-catalog/ + relative path from catalog dir
    const containerPath = '/skills-catalog/' + relativePath.split(path.sep).join('/');

    skills.push({
      name,
      source,
      description,
      categories: skillCategories,
      path: containerPath,
    });
  }

  // Sort by name for deterministic output
  skills.sort((a, b) => a.name.localeCompare(b.name));

  return { skills };
}

/**
 * CLI entry point: generate catalog.json from skills-catalog/ directory.
 */
function main(): void {
  const scriptDir = path.dirname(new URL(import.meta.url).pathname);
  const catalogDir = path.join(scriptDir, 'skills-catalog');
  const categoriesFile = path.join(scriptDir, 'skill-categories.json');

  if (!fs.existsSync(catalogDir)) {
    console.error(`Catalog directory not found: ${catalogDir}`);
    process.exit(1);
  }

  const categories: CategoryConfig = fs.existsSync(categoriesFile)
    ? JSON.parse(fs.readFileSync(categoriesFile, 'utf-8'))
    : { defaults: ['general'], overrides: {} };

  const catalog = generateCatalog(catalogDir, categories);
  const outputPath = path.join(catalogDir, 'catalog.json');
  fs.writeFileSync(outputPath, JSON.stringify(catalog, null, 2) + '\n');

  console.log(`Generated catalog with ${catalog.skills.length} skills → ${outputPath}`);
}

// Run as CLI if invoked directly
const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('generate-catalog.ts') ||
    process.argv[1].endsWith('generate-catalog.js'));

if (isMain) {
  main();
}
