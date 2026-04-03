import fs from 'fs';
import path from 'path';

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
}

export interface SeedGroupMemoryFilesOptions {
  targetDir: string;
  templateDir?: string;
  compatibilityFileName?: string;
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

  return {
    canonical,
    compatibility,
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
