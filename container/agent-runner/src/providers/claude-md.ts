import * as fs from 'fs';
import * as path from 'path';

export function resolveClaudeMdIncludes(
  content: string,
  baseDir: string,
  rootDir = baseDir,
  seen = new Set<string>(),
): string {
  const root = path.resolve(rootDir);

  return content
    .split(/\r?\n/)
    .map((line) => {
      const match = /^\s*@(.+?)\s*$/.exec(line);
      if (!match) {
        return line;
      }

      const includePath = match[1];
      if (!includePath.startsWith('./') && !includePath.startsWith('../')) {
        return line;
      }

      const resolvedPath = path.resolve(baseDir, includePath);
      const relativeToRoot = path.relative(root, resolvedPath);
      const isInsideRoot =
        relativeToRoot === '' || (!relativeToRoot.startsWith('..') && !path.isAbsolute(relativeToRoot));

      if (!isInsideRoot) {
        return line;
      }

      if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        return line;
      }

      if (seen.has(resolvedPath)) {
        return line;
      }

      const nextSeen = new Set(seen);
      nextSeen.add(resolvedPath);

      return resolveClaudeMdIncludes(
        fs.readFileSync(resolvedPath, 'utf-8'),
        path.dirname(resolvedPath),
        root,
        nextSeen,
      ).replace(/\r?\n$/, '');
    })
    .join('\n');
}
