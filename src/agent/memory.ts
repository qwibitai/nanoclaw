import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

export const CANONICAL_MEMORY_FILE = 'AGENT.md';
export const LEGACY_CLAUDE_MEMORY_FILE = 'CLAUDE.md';

export type MemoryAuthority = 'canonical' | 'legacy-seed' | 'provider-rendered';

export interface MemoryFileDescriptor {
  path: string;
  fileName: string;
  exists: boolean;
  authority: MemoryAuthority;
}

export interface ResolvedMemoryLayout {
  canonical: MemoryFileDescriptor;
  compatibility: MemoryFileDescriptor;
  authoritative: MemoryFileDescriptor | null;
}

export interface SeedCanonicalMemoryResult {
  path: string;
  created: boolean;
  seededFrom:
    | 'canonical'
    | 'legacy-seed'
    | 'template-canonical'
    | 'template-compatibility'
    | 'none';
}

export interface SeedCompatibilityMemoryResult {
  path: string;
  created: boolean;
  seededFrom: 'canonical' | 'none';
}

export interface SeedGroupMemoryFilesResult {
  canonical: SeedCanonicalMemoryResult;
  compatibility: SeedCompatibilityMemoryResult;
  migration: FinalizeLegacyCanonicalMemoryResult | null;
}

export interface SeedGroupMemoryFilesOptions {
  targetDir: string;
  templateDir?: string;
  compatibilityFileName?: string;
  canonicalTemplateFingerprint?: string;
}

export interface GlobalMemoryPolicy {
  canonicalPath: string | null;
  allowCompatibilitySyncBack: boolean;
}

export interface ReconcileCompatibilityMemoryOptions {
  canonicalPath: string;
  compatibilityPath: string;
  allowSyncBack?: boolean;
  onWarning?: (warning: string) => void;
}

export interface ReconcileCompatibilityMemoryResult {
  status: 'synced' | 'skipped' | 'warning';
  warning?: string;
}

export interface FinalizeLegacyCanonicalMemoryOptions {
  targetDir: string;
  compatibilityFileName?: string;
  markerFileName?: string;
  canonicalTemplateFingerprint?: string;
}

export interface FinalizeLegacyCanonicalMemoryResult {
  status: 'migrated' | 'skipped';
  reason:
    | 'already-finalized'
    | 'missing-canonical'
    | 'missing-compatibility'
    | 'canonical-preserved'
    | 'identical'
    | 'legacy-promoted';
  canonicalPath: string;
  compatibilityPath: string;
  markerPath: string;
}

const LEGACY_CANONICAL_MEMORY_MARKER_FILE =
  '.canonical-memory-migration-v1.json';
export const DEFAULT_GLOBAL_MEMORY_TEMPLATE_FINGERPRINT =
  '44f4028d333e5b940485b12749dc8030460c6181105c12d71f7866589f7f1334';
export const DEFAULT_MAIN_MEMORY_TEMPLATE_FINGERPRINT =
  'b7cee3ed414fa4d9e97c5a3bf3b754c608a874d817a7d6a09a6aa9c66e309616';

function normalizeMemoryContent(content: string): string {
  return content.replace(/\r\n/g, '\n');
}

function fingerprintMemoryContent(content: string): string {
  return createHash('sha256')
    .update(normalizeMemoryContent(content))
    .digest('hex');
}

function buildCanonicalDescriptor(targetDir: string): MemoryFileDescriptor {
  const canonicalPath = path.join(targetDir, CANONICAL_MEMORY_FILE);
  return {
    path: canonicalPath,
    fileName: CANONICAL_MEMORY_FILE,
    exists: fs.existsSync(canonicalPath),
    authority: 'canonical',
  };
}

export function resolveMemoryLayout(
  targetDir: string,
  compatibilityFileName = LEGACY_CLAUDE_MEMORY_FILE,
): ResolvedMemoryLayout {
  const canonical = buildCanonicalDescriptor(targetDir);
  const compatibilityPath = path.join(targetDir, compatibilityFileName);
  const compatibilityExists = fs.existsSync(compatibilityPath);

  const compatibility: MemoryFileDescriptor = {
    path: compatibilityPath,
    fileName: compatibilityFileName,
    exists: compatibilityExists,
    authority:
      compatibilityExists && !canonical.exists
        ? 'legacy-seed'
        : 'provider-rendered',
  };

  if (canonical.exists) {
    return {
      canonical,
      compatibility,
      authoritative: canonical,
    };
  }

  if (compatibilityExists) {
    return {
      canonical,
      compatibility,
      authoritative: {
        ...compatibility,
        authority: 'legacy-seed',
      },
    };
  }

  return {
    canonical,
    compatibility,
    authoritative: null,
  };
}

function resolveTemplateSeed(
  templateDir: string | undefined,
  compatibilityFileName: string,
): {
  content: string;
  seededFrom: SeedCanonicalMemoryResult['seededFrom'];
} | null {
  if (!templateDir) {
    return null;
  }

  const canonicalTemplatePath = path.join(templateDir, CANONICAL_MEMORY_FILE);
  if (fs.existsSync(canonicalTemplatePath)) {
    return {
      content: fs.readFileSync(canonicalTemplatePath, 'utf-8'),
      seededFrom: 'template-canonical',
    };
  }

  const compatibilityTemplatePath = path.join(
    templateDir,
    compatibilityFileName,
  );
  if (fs.existsSync(compatibilityTemplatePath)) {
    return {
      content: fs.readFileSync(compatibilityTemplatePath, 'utf-8'),
      seededFrom: 'template-compatibility',
    };
  }

  return null;
}

function seedCanonicalMemory(
  options: SeedGroupMemoryFilesOptions,
): SeedCanonicalMemoryResult {
  const compatibilityFileName =
    options.compatibilityFileName || LEGACY_CLAUDE_MEMORY_FILE;
  const layout = resolveMemoryLayout(options.targetDir, compatibilityFileName);

  if (layout.canonical.exists) {
    return {
      path: layout.canonical.path,
      created: false,
      seededFrom: 'canonical',
    };
  }

  let seedContent: string | null = null;
  let seededFrom: SeedCanonicalMemoryResult['seededFrom'] = 'none';

  if (layout.authoritative?.authority === 'legacy-seed') {
    seedContent = fs.readFileSync(layout.authoritative.path, 'utf-8');
    seededFrom = 'legacy-seed';
  } else {
    const templateSeed = resolveTemplateSeed(
      options.templateDir,
      compatibilityFileName,
    );
    if (templateSeed) {
      seedContent = templateSeed.content;
      seededFrom = templateSeed.seededFrom;
    }
  }

  if (seedContent == null) {
    return {
      path: layout.canonical.path,
      created: false,
      seededFrom,
    };
  }

  fs.mkdirSync(options.targetDir, { recursive: true });
  fs.writeFileSync(layout.canonical.path, seedContent);

  return {
    path: layout.canonical.path,
    created: true,
    seededFrom,
  };
}

function seedCompatibilityMemory(
  options: SeedGroupMemoryFilesOptions,
): SeedCompatibilityMemoryResult {
  const compatibilityFileName =
    options.compatibilityFileName || LEGACY_CLAUDE_MEMORY_FILE;
  const layout = resolveMemoryLayout(options.targetDir, compatibilityFileName);

  if (layout.compatibility.exists || !layout.canonical.exists) {
    return {
      path: layout.compatibility.path,
      created: false,
      seededFrom: 'none',
    };
  }

  fs.copyFileSync(layout.canonical.path, layout.compatibility.path);

  return {
    path: layout.compatibility.path,
    created: true,
    seededFrom: 'canonical',
  };
}

export function seedGroupMemoryFiles(
  options: SeedGroupMemoryFilesOptions,
): SeedGroupMemoryFilesResult {
  const canonical = seedCanonicalMemory(options);
  const compatibility = seedCompatibilityMemory(options);
  const migration = options.canonicalTemplateFingerprint
    ? finalizeLegacyCanonicalMemoryOnce({
        targetDir: options.targetDir,
        compatibilityFileName: options.compatibilityFileName,
        canonicalTemplateFingerprint: options.canonicalTemplateFingerprint,
      })
    : null;

  return {
    canonical,
    compatibility,
    migration,
  };
}

export function listManagedMemoryFiles(
  targetDir: string,
  compatibilityFileName = LEGACY_CLAUDE_MEMORY_FILE,
): string[] {
  const layout = resolveMemoryLayout(targetDir, compatibilityFileName);
  return [layout.canonical.path, layout.compatibility.path].filter(
    (filePath, index, allPaths) =>
      fs.existsSync(filePath) && allPaths.indexOf(filePath) === index,
  );
}

export function getGlobalMemoryPolicy(
  projectRoot: string,
  isMain: boolean,
): GlobalMemoryPolicy {
  if (isMain) {
    return {
      canonicalPath: null,
      allowCompatibilitySyncBack: false,
    };
  }

  return {
    canonicalPath: path.join(
      projectRoot,
      'groups',
      'global',
      CANONICAL_MEMORY_FILE,
    ),
    allowCompatibilitySyncBack: false,
  };
}

function writeLegacyCanonicalMarker(
  markerPath: string,
  reason: FinalizeLegacyCanonicalMemoryResult['reason'],
): void {
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(
    markerPath,
    JSON.stringify(
      {
        finalizedAt: new Date().toISOString(),
        reason,
      },
      null,
      2,
    ) + '\n',
  );
}

export function finalizeLegacyCanonicalMemoryOnce(
  options: FinalizeLegacyCanonicalMemoryOptions,
): FinalizeLegacyCanonicalMemoryResult {
  const compatibilityFileName =
    options.compatibilityFileName || LEGACY_CLAUDE_MEMORY_FILE;
  const markerPath = path.join(
    options.targetDir,
    options.markerFileName || LEGACY_CANONICAL_MEMORY_MARKER_FILE,
  );
  const layout = resolveMemoryLayout(options.targetDir, compatibilityFileName);

  if (fs.existsSync(markerPath)) {
    return {
      status: 'skipped',
      reason: 'already-finalized',
      canonicalPath: layout.canonical.path,
      compatibilityPath: layout.compatibility.path,
      markerPath,
    };
  }

  if (!layout.canonical.exists) {
    return {
      status: 'skipped',
      reason: 'missing-canonical',
      canonicalPath: layout.canonical.path,
      compatibilityPath: layout.compatibility.path,
      markerPath,
    };
  }

  if (!layout.compatibility.exists) {
    writeLegacyCanonicalMarker(markerPath, 'missing-compatibility');
    return {
      status: 'skipped',
      reason: 'missing-compatibility',
      canonicalPath: layout.canonical.path,
      compatibilityPath: layout.compatibility.path,
      markerPath,
    };
  }

  const canonicalContent = fs.readFileSync(layout.canonical.path, 'utf-8');
  const compatibilityContent = fs.readFileSync(
    layout.compatibility.path,
    'utf-8',
  );

  if (
    normalizeMemoryContent(canonicalContent) ===
    normalizeMemoryContent(compatibilityContent)
  ) {
    writeLegacyCanonicalMarker(markerPath, 'identical');
    return {
      status: 'skipped',
      reason: 'identical',
      canonicalPath: layout.canonical.path,
      compatibilityPath: layout.compatibility.path,
      markerPath,
    };
  }

  if (
    !options.canonicalTemplateFingerprint ||
    fingerprintMemoryContent(canonicalContent) !==
      options.canonicalTemplateFingerprint
  ) {
    writeLegacyCanonicalMarker(markerPath, 'canonical-preserved');
    return {
      status: 'skipped',
      reason: 'canonical-preserved',
      canonicalPath: layout.canonical.path,
      compatibilityPath: layout.compatibility.path,
      markerPath,
    };
  }

  fs.writeFileSync(layout.canonical.path, compatibilityContent);
  writeLegacyCanonicalMarker(markerPath, 'legacy-promoted');
  return {
    status: 'migrated',
    reason: 'legacy-promoted',
    canonicalPath: layout.canonical.path,
    compatibilityPath: layout.compatibility.path,
    markerPath,
  };
}

export function reconcileCompatibilityMemory(
  options: ReconcileCompatibilityMemoryOptions,
): ReconcileCompatibilityMemoryResult {
  if (!fs.existsSync(options.compatibilityPath)) {
    return { status: 'skipped' };
  }

  if (!options.allowSyncBack) {
    return { status: 'skipped' };
  }

  if (!fs.existsSync(options.canonicalPath)) {
    const warning = `Cannot reconcile ${path.basename(options.compatibilityPath)} into ${path.basename(options.canonicalPath)} because canonical memory is missing.`;
    options.onWarning?.(warning);
    return {
      status: 'warning',
      warning,
    };
  }

  const canonicalContent = fs.readFileSync(options.canonicalPath, 'utf-8');
  const compatibilityContent = fs.readFileSync(
    options.compatibilityPath,
    'utf-8',
  );

  if (canonicalContent === compatibilityContent) {
    return { status: 'skipped' };
  }

  fs.writeFileSync(options.canonicalPath, compatibilityContent);
  return { status: 'synced' };
}
