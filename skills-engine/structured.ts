import { execSync } from 'child_process';
import fs from 'fs';
import { parse, stringify } from 'yaml';

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

interface DockerComposeFile {
  version?: string;
  services?: Record<string, unknown>;
  [key: string]: unknown;
}

function compareVersionParts(a: string[], b: string[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const aNum = parseInt(a[i] ?? '0', 10);
    const bNum = parseInt(b[i] ?? '0', 10);
    if (aNum !== bNum) return aNum - bNum;
  }
  return 0;
}

export function areRangesCompatible(
  existing: string,
  requested: string,
): { compatible: boolean; resolved: string } {
  if (existing === requested) {
    return { compatible: true, resolved: existing };
  }

  // Both start with ^
  if (existing.startsWith('^') && requested.startsWith('^')) {
    const eParts = existing.slice(1).split('.');
    const rParts = requested.slice(1).split('.');
    if (eParts[0] !== rParts[0]) {
      return { compatible: false, resolved: existing };
    }
    // Same major — take the higher version
    const resolved =
      compareVersionParts(eParts, rParts) >= 0 ? existing : requested;
    return { compatible: true, resolved };
  }

  // Both start with ~
  if (existing.startsWith('~') && requested.startsWith('~')) {
    const eParts = existing.slice(1).split('.');
    const rParts = requested.slice(1).split('.');
    if (eParts[0] !== rParts[0] || eParts[1] !== rParts[1]) {
      return { compatible: false, resolved: existing };
    }
    // Same major.minor — take higher patch
    const resolved =
      compareVersionParts(eParts, rParts) >= 0 ? existing : requested;
    return { compatible: true, resolved };
  }

  // Mismatched prefixes or anything else (exact, >=, *, etc.)
  return { compatible: false, resolved: existing };
}

export function mergeNpmDependencies(
  packageJsonPath: string,
  newDeps: Record<string, string>,
): void {
  const content = fs.readFileSync(packageJsonPath, 'utf-8');
  const pkg: PackageJson = JSON.parse(content);

  pkg.dependencies = pkg.dependencies || {};

  for (const [name, version] of Object.entries(newDeps)) {
    // Check both dependencies and devDependencies to avoid duplicates
    const existing = pkg.dependencies[name] ?? pkg.devDependencies?.[name];
    if (existing && existing !== version) {
      const result = areRangesCompatible(existing, version);
      if (!result.compatible) {
        throw new Error(
          `Dependency conflict: ${name} is already at ${existing}, skill wants ${version}`,
        );
      }
      pkg.dependencies[name] = result.resolved;
    } else {
      pkg.dependencies[name] = version;
    }
  }

  // Sort dependencies for deterministic output
  pkg.dependencies = Object.fromEntries(
    Object.entries(pkg.dependencies).sort(([a], [b]) => a.localeCompare(b)),
  );

  if (pkg.devDependencies) {
    pkg.devDependencies = Object.fromEntries(
      Object.entries(pkg.devDependencies).sort(([a], [b]) =>
        a.localeCompare(b),
      ),
    );
  }

  fs.writeFileSync(
    packageJsonPath,
    JSON.stringify(pkg, null, 2) + '\n',
    'utf-8',
  );
}

export function mergeEnvAdditions(
  envExamplePath: string,
  additions: string[],
): void {
  let content = '';
  if (fs.existsSync(envExamplePath)) {
    content = fs.readFileSync(envExamplePath, 'utf-8');
  }

  const existingVars = new Set<string>();
  for (const line of content.split('\n')) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (match) existingVars.add(match[1]);
  }

  const newVars = additions.filter((v) => !existingVars.has(v));
  if (newVars.length === 0) return;

  if (content && !content.endsWith('\n')) content += '\n';
  content += '\n# Added by skill\n';
  for (const v of newVars) {
    content += `${v}=\n`;
  }

  fs.writeFileSync(envExamplePath, content, 'utf-8');
}

function extractHostPort(portMapping: string): string | null {
  const str = String(portMapping);
  const parts = str.split(':');
  if (parts.length >= 2) {
    return parts[0];
  }
  return null;
}

export function mergeDockerComposeServices(
  composePath: string,
  services: Record<string, unknown>,
): void {
  let compose: DockerComposeFile;

  if (fs.existsSync(composePath)) {
    const content = fs.readFileSync(composePath, 'utf-8');
    compose = (parse(content) as DockerComposeFile) || {};
  } else {
    compose = { version: '3' };
  }

  compose.services = compose.services || {};

  // Collect host ports from existing services
  const usedPorts = new Set<string>();
  for (const [, svc] of Object.entries(compose.services)) {
    const service = svc as Record<string, unknown>;
    if (Array.isArray(service.ports)) {
      for (const p of service.ports) {
        const host = extractHostPort(String(p));
        if (host) usedPorts.add(host);
      }
    }
  }

  // Add new services, checking for port collisions
  for (const [name, definition] of Object.entries(services)) {
    if (compose.services[name]) continue; // skip existing

    const svc = definition as Record<string, unknown>;
    if (Array.isArray(svc.ports)) {
      for (const p of svc.ports) {
        const host = extractHostPort(String(p));
        if (host && usedPorts.has(host)) {
          throw new Error(
            `Port collision: host port ${host} from service "${name}" is already in use`,
          );
        }
        if (host) usedPorts.add(host);
      }
    }

    compose.services[name] = definition;
  }

  fs.writeFileSync(composePath, stringify(compose), 'utf-8');
}

export function runNpmInstall(): void {
  execSync('npm install --legacy-peer-deps', {
    stdio: 'inherit',
    cwd: process.cwd(),
  });
}
