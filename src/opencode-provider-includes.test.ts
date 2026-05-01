import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, it } from 'vitest';

type ResolveClaudeMdIncludes = (content: string, baseDir: string, rootDir?: string, seen?: Set<string>) => string;

type ClaudeMdModule = {
  resolveClaudeMdIncludes: ResolveClaudeMdIncludes;
};

async function loadResolveClaudeMdIncludes(): Promise<ResolveClaudeMdIncludes> {
  const modulePath = pathToFileURL(path.resolve('container/agent-runner/src/providers/claude-md.ts')).href;

  const module = (await import(modulePath)) as ClaudeMdModule;
  return module.resolveClaudeMdIncludes;
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-opencode-'));
}

describe('OpenCode provider CLAUDE.md include resolution', () => {
  it('expands whole-line local Claude-style includes', async () => {
    const resolveClaudeMdIncludes = await loadResolveClaudeMdIncludes();
    const root = makeTempDir();
    fs.mkdirSync(path.join(root, '.claude-fragments'), { recursive: true });

    fs.writeFileSync(
      path.join(root, 'CLAUDE.md'),
      ['before', '@./.claude-shared.md', '@./.claude-fragments/module-self-mod.md', 'after', ''].join('\n'),
    );

    fs.writeFileSync(
      path.join(root, '.claude-shared.md'),
      'SHARED_SENTINEL: this base instruction should reach the model.\n',
    );

    fs.writeFileSync(
      path.join(root, '.claude-fragments/module-self-mod.md'),
      'FRAGMENT_SENTINEL: OneCLI agent vault instructions should reach the model.\n',
    );

    const resolved = resolveClaudeMdIncludes(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf-8'), root);

    expect(resolved).toContain('before');
    expect(resolved).toContain('SHARED_SENTINEL');
    expect(resolved).toContain('FRAGMENT_SENTINEL');
    expect(resolved).toContain('after');
    expect(resolved).not.toContain('@./.claude-shared.md');
    expect(resolved).not.toContain('@./.claude-fragments/module-self-mod.md');
  });

  it('expands nested local includes relative to the included file', async () => {
    const resolveClaudeMdIncludes = await loadResolveClaudeMdIncludes();
    const root = makeTempDir();
    fs.mkdirSync(path.join(root, 'fragments', 'nested'), { recursive: true });

    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '@./fragments/outer.md\n');
    fs.writeFileSync(path.join(root, 'fragments', 'outer.md'), 'outer\n@./nested/inner.md\n');
    fs.writeFileSync(path.join(root, 'fragments', 'nested', 'inner.md'), 'INNER_SENTINEL\n');

    const resolved = resolveClaudeMdIncludes(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf-8'), root);

    expect(resolved).toContain('outer');
    expect(resolved).toContain('INNER_SENTINEL');
    expect(resolved).not.toContain('@./fragments/outer.md');
    expect(resolved).not.toContain('@./nested/inner.md');
  });

  it('leaves missing includes literal instead of silently deleting them', async () => {
    const resolveClaudeMdIncludes = await loadResolveClaudeMdIncludes();
    const root = makeTempDir();

    const resolved = resolveClaudeMdIncludes('@./missing.md\n', root);

    expect(resolved).toContain('@./missing.md');
  });

  it('does not expand includes that escape the instruction root', async () => {
    const resolveClaudeMdIncludes = await loadResolveClaudeMdIncludes();
    const root = makeTempDir();
    const outside = makeTempDir();

    fs.writeFileSync(path.join(outside, 'secret.md'), 'SHOULD_NOT_BE_INCLUDED\n');

    const resolved = resolveClaudeMdIncludes(`@../${path.basename(outside)}/secret.md\n`, root);

    expect(resolved).not.toContain('SHOULD_NOT_BE_INCLUDED');
    expect(resolved).toContain('@../');
  });

  it('keeps cyclic includes literal at the cycle point', async () => {
    const resolveClaudeMdIncludes = await loadResolveClaudeMdIncludes();
    const root = makeTempDir();

    fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'root\n@./a.md\n');
    fs.writeFileSync(path.join(root, 'a.md'), 'a\n@./b.md\n');
    fs.writeFileSync(path.join(root, 'b.md'), 'b\n@./a.md\n');

    const resolved = resolveClaudeMdIncludes(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf-8'), root);

    expect(resolved).toContain('root');
    expect(resolved).toContain('a');
    expect(resolved).toContain('b');
    expect(resolved).toContain('@./a.md');
  });
});
