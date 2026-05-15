#!/usr/bin/env node
/**
 * Safe trade video director for Thedius Builder.
 *
 * Hyperframes-inspired workflow, implemented natively:
 * - one non-interactive CLI
 * - doctor/catalog/lint utilities
 * - deterministic scene blocks
 * - optional media preprocessing
 * - safe Remotion render handoff
 *
 * No Hyperframes code is imported. No generated code is executed.
 */
import { existsSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rawArgs = process.argv.slice(2).filter((arg) => arg !== '--');
const command = rawArgs.shift();
const args = parseArgs(rawArgs);

const SCENE_TYPES = new Set(['title', 'bullets', 'metric', 'lineChart', 'barChart', 'quote', 'split', 'end']);
const THEMES = new Set(['marex', 'clean', 'editorial']);

if (!command || command === 'help' || args.help || args.h) {
  printUsage();
  process.exit(0);
}

try {
  let result;
  if (command === 'doctor') result = commandDoctor();
  else if (command === 'catalog') result = commandCatalog();
  else if (command === 'lint') result = await commandLint(positionals(args)[0]);
  else if (command === 'make') result = await commandMake();
  else throw new Error(`Unknown command: ${command}`);

  await emit(result);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

async function commandMake() {
  if (args.format && args.format !== 'wide') {
    throw new Error('Only --format wide is supported by the current SafeStoryboard renderer');
  }

  const projectSlug = makeProjectSlug();
  const projectDir = path.resolve(args['project-dir'] || path.join(workspaceAgentDir(), 'projects', projectSlug));
  await fs.mkdir(projectDir, { recursive: true });

  const ideaLab = runIdeaLab();
  const brief = buildBrief(ideaLab);
  const storyboard = buildStoryboard(brief, ideaLab);
  const narration = buildNarration(brief, ideaLab);
  const files = {
    projectDir,
    ideaLabJson: path.join(projectDir, 'trade-lab.json'),
    storyboardJson: path.join(projectDir, 'storyboard.json'),
    narrationTxt: path.join(projectDir, 'narration.txt'),
    manifestJson: path.join(projectDir, 'manifest.json'),
    renderLog: path.join(projectDir, 'render.log'),
    lintJson: path.join(projectDir, 'lint.json'),
  };

  await fs.writeFile(files.ideaLabJson, `${JSON.stringify(ideaLab, null, 2)}\n`, 'utf8');
  await fs.writeFile(files.narrationTxt, `${narration}\n`, 'utf8');

  let audio = null;
  if (!args['no-tts'] && !args['dry-run']) {
    audio = runTts(projectSlug, files.narrationTxt);
    storyboard.storyboard.audio = { narration: { src: audio.relativePath, volume: 1 } };
  }

  await fs.writeFile(files.storyboardJson, `${JSON.stringify(storyboard, null, 2)}\n`, 'utf8');
  const composerPropsPath = await writeComposerProps(projectSlug, storyboard);
  const lint = lintStoryboard(storyboard);
  await fs.writeFile(files.lintJson, `${JSON.stringify(lint, null, 2)}\n`, 'utf8');
  if (!lint.ok) {
    throw new Error(`Storyboard lint failed: ${lint.errors.join('; ')}`);
  }

  let render = null;
  if (args.render && !args['dry-run']) {
    render = runRender(projectSlug, composerPropsPath, files.renderLog);
  }

  const manifest = {
    kind: 'tradeVideoDirector',
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    slug: projectSlug,
    title: brief.title,
    input: publicInput(),
    format: 'wide',
    durationSeconds: storyboard.storyboard.scenes.reduce((sum, scene) => sum + (scene.durationSeconds || 0), 0),
    files: {
      ...files,
      composerPropsPath,
      audioRelativePath: audio?.relativePath || null,
      videoPath: render?.videoPath || null,
    },
    ideaLabSummary: {
      symbol: ideaLab.instrument?.symbol || null,
      direction: ideaLab.input?.direction || null,
      latestPrice: ideaLab.latest?.price ?? null,
      latestChangePct: ideaLab.latest?.changePct ?? null,
      trendRegime: ideaLab.trend?.trendRegime || null,
      maxDrawdown: ideaLab.risk?.maxDrawdown ?? null,
      selectedTemplate: selectedBacktest(ideaLab)?.name || null,
      selectedTemplateReturn: selectedBacktest(ideaLab)?.totalReturn ?? null,
    },
    render,
    lint,
    safety: {
      importedHyperframesCode: false,
      importedExternalVideoCode: false,
      generatedCodeExecution: false,
      brokerEndpoints: false,
      renderer: 'SafeStoryboard',
      sceneTypes: [...SCENE_TYPES],
    },
  };
  await fs.writeFile(files.manifestJson, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return { kind: 'make', manifest };
}

function commandDoctor() {
  const checks = [
    checkPath('Trade Lab script', ideaLabPath()),
    checkPath('Render helper', renderHelperPath()),
    checkPath('Voice helper', voiceHelperPath()),
    checkPath('Remotion source mount', remotionSourceDir()),
    checkCommand('node'),
    checkCommand('ffmpeg'),
    checkCommand('ffprobe'),
  ];
  const ok = checks.every((check) => check.ok || check.optional);
  return {
    kind: 'doctor',
    ok,
    checks,
    note: ok
      ? 'Trade Video Director is ready.'
      : 'One or more required paths are missing. Builder may need a fresh container spawn or mount config check.',
  };
}

function commandCatalog() {
  return {
    kind: 'catalog',
    blocks: [
      { name: 'hook', sceneType: 'title', purpose: 'Open with instrument, thesis, and data-led framing.' },
      { name: 'source', sceneType: 'quote', purpose: 'Show the source-mentioned idea or manual premise.' },
      { name: 'live-tape', sceneType: 'metric', purpose: 'Latest price and daily move.' },
      { name: 'trend', sceneType: 'barChart', purpose: '21d/63d/126d/252d return snapshot.' },
      { name: 'template-check', sceneType: 'split', purpose: 'Backtest template versus risk flags.' },
      { name: 'risk-checks', sceneType: 'bullets', purpose: 'Invalidation and follow-up checks.' },
      { name: 'close', sceneType: 'end', purpose: 'Research-only closing card.' },
    ],
    templates: ['45s-standard', '60s-standard'],
    renderer: 'SafeStoryboard',
    safety: 'No arbitrary HTML/React/video code. Scene JSON only.',
  };
}

async function commandLint(filePath) {
  if (!filePath) throw new Error('lint requires a storyboard JSON path');
  const json = JSON.parse(await fs.readFile(path.resolve(filePath), 'utf8'));
  return { kind: 'lint', path: path.resolve(filePath), ...lintStoryboard(json) };
}

function runIdeaLab() {
  const labArgs = ['analyze', '--json', '--range', args.range || '1y', '--strategy', args.strategy || 'ma-cross'];
  if (args.idea) labArgs.push('--idea', args.idea);
  else {
    if (!args.asset) throw new Error('make requires --idea or --asset');
    labArgs.push('--asset', args.asset);
    if (args.title) labArgs.push('--title', args.title);
    if (args.direction) labArgs.push('--direction', args.direction);
    if (args.benchmark) labArgs.push('--benchmark', args.benchmark);
    if (args.peers) labArgs.push('--peers', args.peers);
  }
  if (args.ledger) labArgs.push('--ledger', args.ledger);
  if (args['cost-bps']) labArgs.push('--cost-bps', args['cost-bps']);

  const result = spawnSync(process.execPath, [ideaLabPath(), ...labArgs], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`Trade Lab failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return JSON.parse(result.stdout);
}

function runTts(projectSlug, narrationPath) {
  const relativePath = `voice/${projectSlug}.wav`;
  const result = spawnSync(voiceHelperPath(), [narrationPath, relativePath], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`Narration generation failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return { relativePath, helperOutput: result.stdout.trim() };
}

function runRender(projectSlug, composerPropsPath, logPath) {
  const relativeProps = composerRelativePropsPath(composerPropsPath);
  const relativeOutput = `out/${projectSlug}.mp4`;
  const result = spawnSync(renderHelperPath(), ['SafeStoryboard', relativeProps, relativeOutput], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    env: process.env,
  });
  const log = [
    '# Trade Video Render Log',
    '',
    `Command: ${renderHelperPath()} SafeStoryboard ${relativeProps} ${relativeOutput}`,
    '',
    '## STDOUT',
    result.stdout || '',
    '',
    '## STDERR',
    result.stderr || '',
  ].join('\n');
  fs.writeFile(logPath, log, 'utf8').catch(() => {});
  if (result.status !== 0) {
    throw new Error(`Render failed. See ${logPath}: ${(result.stderr || result.stdout || '').slice(0, 1200).trim()}`);
  }

  const printedPath = result.stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .at(-1);
  const videoPath = printedPath && printedPath.endsWith('.mp4') ? printedPath : path.join(remotionWorkDir(), relativeOutput);
  return {
    videoPath,
    verified: verifyVideo(videoPath),
  };
}

function verifyVideo(videoPath) {
  if (!existsSync(videoPath)) return { ok: false, reason: 'video file missing' };
  const ffprobe = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'stream=index,codec_type,codec_name', '-of', 'csv=p=0', videoPath],
    { encoding: 'utf8' },
  );
  if (ffprobe.status !== 0) {
    return { ok: true, note: 'video exists; ffprobe unavailable or failed' };
  }
  const streams = ffprobe.stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split(','));
  return {
    ok: streams.some((stream) => stream.includes('video')),
    hasAudio: streams.some((stream) => stream.includes('audio')),
    streams: streams.map((stream) => ({ index: stream[0], codec: stream[1], type: stream[2] })),
  };
}

function buildBrief(ideaLab) {
  const symbol = ideaLab.instrument?.symbol || ideaLab.instrument?.input || args.asset || 'Market';
  const manualTitle = args.title || ideaLab.input?.title || `Trade idea: ${symbol}`;
  const selected = selectedBacktest(ideaLab);
  const baseline = ideaLab.backtests?.[0];
  const sourceQuote =
    ideaLab.sourceIdea?.quote ||
    args.thesis ||
    `${manualTitle}. This is a manual premise, pressure-tested through Trade Lab.`;
  return {
    title: truncateText(manualTitle, 86),
    symbol,
    direction: ideaLab.input?.direction || args.direction || 'view',
    source: ideaLab.sourceIdea?.source || 'Manual premise',
    sourceQuote: truncateText(sourceQuote, 360),
    latestLine: `${formatMoney(ideaLab.latest?.price, ideaLab.latest?.currency)} ${formatPct(ideaLab.latest?.changePct)} on latest Yahoo tape`,
    trendLine: `${capitalize(ideaLab.trend?.trendRegime || 'mixed')} trend; ${formatPct(ideaLab.trend?.return21d)} over 21d`,
    riskLine: `${formatPct(ideaLab.risk?.annualizedVol)} annualized vol; ${formatPct(ideaLab.risk?.maxDrawdown)} max drawdown in sample`,
    backtestLine: selected
      ? `${selected.name} is ${selected.latestSignalLabel}, return ${formatPct(selected.totalReturn)}, max drawdown ${formatPct(selected.maxDrawdown)}`
      : 'No selected template backtest',
    baselineLine: baseline ? `Directional baseline return ${formatPct(baseline.totalReturn)}` : '',
    checks: [...(ideaLab.readout?.flags || []), ...(ideaLab.readout?.checks || [])].slice(0, 5),
  };
}

function buildStoryboard(brief, ideaLab) {
  const theme = THEMES.has(args.theme) ? args.theme : 'marex';
  const accentColor = args.accent || defaultAccent(brief.symbol);
  const selected = selectedBacktest(ideaLab);
  const trendBars = [
    { label: '21d', value: pctNumber(ideaLab.trend?.return21d) },
    { label: '63d', value: pctNumber(ideaLab.trend?.return63d) },
    { label: '126d', value: pctNumber(ideaLab.trend?.return126d) },
    { label: '252d', value: pctNumber(ideaLab.trend?.return252d) },
  ].filter((point) => Number.isFinite(point.value));

  const scenes = [
    {
      type: 'title',
      durationSeconds: 5,
      eyebrow: `${brief.symbol} | ${String(brief.direction).toUpperCase()} | TRADE LAB`,
      headline: brief.title,
      subheadline: 'A source idea pressure-tested through live tape, risk, and fixed templates.',
      kicker: 'SafeStoryboard production',
    },
    {
      type: 'quote',
      durationSeconds: 6,
      quote: brief.sourceQuote,
      source: brief.source,
    },
    {
      type: 'metric',
      durationSeconds: 5,
      label: 'Live tape',
      value: formatMoney(ideaLab.latest?.price, ideaLab.latest?.currency),
      helper: `${formatPct(ideaLab.latest?.changePct)} latest move. ${brief.trendLine}.`,
      trend: trendFromPct(ideaLab.latest?.changePct),
    },
    {
      type: 'barChart',
      durationSeconds: 6,
      title: 'Trend snapshot',
      subtitle: `${brief.symbol} returns across windows`,
      bars: trendBars.length ? trendBars : [{ label: 'sample', value: pctNumber(ideaLab.risk?.periodReturn) }],
      yLabel: '%',
    },
    {
      type: 'split',
      durationSeconds: 7,
      title: 'Template check vs risk',
      leftTitle: selected ? selected.name : 'Template',
      leftBody: `${brief.backtestLine}. ${brief.baselineLine}`.trim(),
      rightTitle: 'Risk tape',
      rightBody: `${brief.riskLine}. Beta ${formatNumber(ideaLab.risk?.betaToBenchmark, 2)}, corr ${formatNumber(ideaLab.risk?.corrToBenchmark, 2)} to benchmark.`,
    },
    {
      type: 'bullets',
      durationSeconds: 8,
      title: 'What still needs checking',
      bullets: brief.checks.map((check) => truncateText(check, 120)).slice(0, 5),
      footnote: 'Fixed-template check only. Research support, not a recommendation.',
    },
    {
      type: 'end',
      durationSeconds: 4,
      text: `${brief.symbol}: research card complete`,
      subtext: 'Source idea + Trade Lab + SafeStoryboard',
    },
  ];

  return {
    storyboard: {
      title: brief.title,
      theme,
      accentColor,
      scenes,
    },
  };
}

function buildNarration(brief, ideaLab) {
  const selected = selectedBacktest(ideaLab);
  return [
    `${brief.title}.`,
    `This is a research video, built from a source idea and a Trade Lab run.`,
    `The premise is: ${brief.sourceQuote}`,
    `On the latest tape, ${brief.symbol} is at ${formatMoney(ideaLab.latest?.price, ideaLab.latest?.currency)}, with a latest move of ${formatPct(ideaLab.latest?.changePct)}.`,
    `The trend read is ${ideaLab.trend?.trendRegime || 'mixed'}, with a twenty one day return of ${formatPct(ideaLab.trend?.return21d)}.`,
    selected
      ? `The selected fixed template is ${selected.name}. Its latest signal is ${selected.latestSignalLabel}, with a sample return of ${formatPct(selected.totalReturn)} and max drawdown of ${formatPct(selected.maxDrawdown)}.`
      : `No fixed template was selected.`,
    `The risk tape matters: annualized volatility is ${formatPct(ideaLab.risk?.annualizedVol)}, and sample max drawdown is ${formatPct(ideaLab.risk?.maxDrawdown)}.`,
    `The conclusion is not a trade call. It is a checklist: confirm the catalyst, define invalidation, check liquidity, and only then decide whether the idea deserves more work.`,
  ].join(' ');
}

async function writeComposerProps(projectSlug, storyboard) {
  const outDir = path.join(remotionWorkDir(), 'public', 'demo-props');
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `${projectSlug}.json`);
  await fs.writeFile(outPath, `${JSON.stringify(storyboard, null, 2)}\n`, 'utf8');
  return outPath;
}

function lintStoryboard(json) {
  const errors = [];
  const warnings = [];
  const storyboard = json?.storyboard;
  if (!storyboard || typeof storyboard !== 'object' || Array.isArray(storyboard)) errors.push('Missing storyboard object');
  const scenes = Array.isArray(storyboard?.scenes) ? storyboard.scenes : [];
  if (scenes.length === 0) errors.push('No scenes');
  if (scenes.length > 12) errors.push('Too many scenes; max 12');
  if (storyboard?.theme && !THEMES.has(storyboard.theme)) errors.push(`Unsupported theme: ${storyboard.theme}`);
  if (storyboard?.accentColor && !/^#[0-9A-Fa-f]{6}$/.test(storyboard.accentColor)) {
    errors.push('accentColor must be #RRGGBB');
  }
  if (storyboard?.audio?.narration?.src && !safeRelativeAudio(storyboard.audio.narration.src)) {
    errors.push('Unsafe narration audio src');
  }

  scenes.forEach((scene, index) => {
    if (!scene || typeof scene !== 'object') {
      errors.push(`Scene ${index + 1} is not an object`);
      return;
    }
    if (!SCENE_TYPES.has(scene.type)) errors.push(`Scene ${index + 1} has unsupported type: ${scene.type}`);
    const duration = Number(scene.durationSeconds || 0);
    if (!Number.isFinite(duration) || duration < 2 || duration > 18) {
      errors.push(`Scene ${index + 1} durationSeconds must be between 2 and 18`);
    }
    for (const [key, value] of Object.entries(scene)) {
      if (typeof value === 'string' && value.length > 420) {
        warnings.push(`Scene ${index + 1} field ${key} is long and may be truncated by the renderer`);
      }
    }
  });

  return { ok: errors.length === 0, errors, warnings, sceneCount: scenes.length };
}

function selectedBacktest(ideaLab) {
  const strategy = ideaLab.input?.strategy;
  return ideaLab.backtests?.find((item) => item.name === strategy) || ideaLab.backtests?.[1] || ideaLab.backtests?.[0] || null;
}

function makeProjectSlug() {
  if (args.slug) return slugify(args.slug);
  const stem = args.idea || args.asset || args.title || 'trade-video';
  return `${new Date().toISOString().slice(0, 10)}-${slugify(stem).slice(0, 70)}`;
}

function publicInput() {
  return {
    idea: args.idea || null,
    title: args.title || null,
    asset: args.asset || null,
    direction: args.direction || null,
    strategy: args.strategy || 'ma-cross',
    range: args.range || '1y',
    benchmark: args.benchmark || null,
    peers: args.peers || null,
    render: Boolean(args.render),
    tts: !args['no-tts'],
  };
}

function checkPath(label, targetPath, optional = false) {
  return { label, path: targetPath, ok: existsSync(targetPath), optional };
}

function checkCommand(name, optional = true) {
  const result = spawnSync('which', [name], { encoding: 'utf8' });
  return { label: `Command: ${name}`, path: result.stdout.trim() || null, ok: result.status === 0, optional };
}

function workspaceAgentDir() {
  if (existsSync('/workspace/agent')) return '/workspace/agent';
  return path.join(process.cwd(), 'groups', 'thedius_builder');
}

function remotionSourceDir() {
  if (process.env.REMOTION_SOURCE_DIR) return process.env.REMOTION_SOURCE_DIR;
  if (existsSync('/workspace/extra/remotion-composer-src')) return '/workspace/extra/remotion-composer-src';
  return '/Users/ilansolot/OpenMontage/remotion-composer';
}

function remotionWorkDir() {
  if (process.env.REMOTION_WORK_DIR) return process.env.REMOTION_WORK_DIR;
  if (existsSync('/workspace/agent')) return '/workspace/agent/remotion-work/remotion-composer';
  return path.join(process.cwd(), 'groups', 'thedius_builder', 'remotion-work', 'remotion-composer');
}

function ideaLabPath() {
  const containerPath = '/app/skills/finance-analyst/scripts/idea-lab.mjs';
  if (existsSync(containerPath)) return containerPath;
  return path.resolve(__dirname, '..', '..', 'finance-analyst', 'scripts', 'idea-lab.mjs');
}

function renderHelperPath() {
  const containerPath = '/workspace/agent/bin/render-safe-storyboard.sh';
  if (existsSync(containerPath)) return containerPath;
  return path.join(process.cwd(), 'groups', 'thedius_builder', 'bin', 'render-safe-storyboard.sh');
}

function voiceHelperPath() {
  const containerPath = '/workspace/agent/bin/make-safe-storyboard-voice.sh';
  if (existsSync(containerPath)) return containerPath;
  return path.join(process.cwd(), 'groups', 'thedius_builder', 'bin', 'make-safe-storyboard-voice.sh');
}

function composerRelativePropsPath(composerPropsPath) {
  const rel = path.relative(remotionWorkDir(), composerPropsPath);
  return rel.startsWith('..') ? composerPropsPath : rel;
}

function safeRelativeAudio(src) {
  return (
    typeof src === 'string' &&
    src.length < 180 &&
    !src.startsWith('/') &&
    !src.includes('..') &&
    !src.includes(':') &&
    !src.includes('\\') &&
    /\.(aac|flac|m4a|mp3|ogg|wav)$/i.test(src)
  );
}

async function emit(result) {
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderMarkdown(result));
}

function renderMarkdown(result) {
  if (result.kind === 'doctor') {
    return [
      '# Trade Video Director Doctor',
      '',
      `Status: ${result.ok ? 'ok' : 'needs attention'}`,
      '',
      table(
        ['Check', 'OK', 'Path'],
        result.checks.map((check) => [check.label, check.ok ? 'yes' : check.optional ? 'optional missing' : 'no', check.path || '']),
      ),
      '',
      result.note,
    ].join('\n');
  }
  if (result.kind === 'catalog') {
    return [
      '# Trade Video Director Catalog',
      '',
      table(
        ['Block', 'Scene', 'Purpose'],
        result.blocks.map((block) => [block.name, block.sceneType, block.purpose]),
      ),
      '',
      `Renderer: ${result.renderer}`,
      `Safety: ${result.safety}`,
    ].join('\n');
  }
  if (result.kind === 'lint') {
    return [
      '# Storyboard Lint',
      '',
      `Path: ${result.path}`,
      `Status: ${result.ok ? 'ok' : 'failed'}`,
      `Scenes: ${result.sceneCount}`,
      result.errors.length ? `Errors: ${result.errors.join('; ')}` : 'Errors: none',
      result.warnings.length ? `Warnings: ${result.warnings.join('; ')}` : 'Warnings: none',
    ].join('\n');
  }
  if (result.kind === 'make') {
    const m = result.manifest;
    return [
      '# Trade Video Package',
      '',
      `Title: ${m.title}`,
      `Project: ${m.files.projectDir}`,
      `Storyboard: ${m.files.storyboardJson}`,
      `Narration: ${m.files.narrationTxt}`,
      `Manifest: ${m.files.manifestJson}`,
      m.files.videoPath ? `Video: ${m.files.videoPath}` : 'Video: not rendered',
      m.render?.verified ? `Verify: ${m.render.verified.ok ? 'video ok' : 'check failed'}; audio ${m.render.verified.hasAudio ? 'yes' : 'no'}` : '',
      '',
      `Trade Lab: ${m.ideaLabSummary.symbol}; ${m.ideaLabSummary.trendRegime}; template ${m.ideaLabSummary.selectedTemplate || 'n/a'}`,
      'Safety: no external video code, no generated code execution, SafeStoryboard only.',
    ]
      .filter((line) => line !== '')
      .join('\n');
  }
  return JSON.stringify(result, null, 2);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function positionals(parsed) {
  return parsed._ || [];
}

function table(headers, rows) {
  const safeRows = rows.map((row) => row.map((cell) => escapeCell(cell)));
  return [
    `| ${headers.map(escapeCell).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...safeRows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function escapeCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replace(/\s+/g, ' ').trim();
}

function slugify(value) {
  return String(value || 'trade-video')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
}

function truncateText(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function pctNumber(value) {
  return Number.isFinite(value) ? Number((value * 100).toFixed(2)) : null;
}

function formatPct(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : 'n/a';
}

function formatNumber(value, digits = 2) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : 'n/a';
}

function formatMoney(value, currency = '') {
  if (!Number.isFinite(value)) return 'n/a';
  const prefix = currency === 'USD' ? '$' : '';
  return `${prefix}${Number(value).toFixed(value > 100 ? 2 : 4)}`;
}

function trendFromPct(value) {
  if (!Number.isFinite(value) || Math.abs(value) < 0.001) return 'flat';
  return value > 0 ? 'up' : 'down';
}

function defaultAccent(symbol) {
  const s = String(symbol || '').toUpperCase();
  if (s.includes('NVDA')) return '#76B900';
  if (s.includes('BTC')) return '#F7931A';
  if (s.includes('CL=F') || s.includes('OIL')) return '#D97A1F';
  if (s.includes('GC=F') || s.includes('GOLD')) return '#F5C518';
  return '#F5C518';
}

function capitalize(value) {
  const text = String(value || '');
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : text;
}

function printUsage() {
  console.log(`Usage:
  node trade-video-director.mjs doctor
  node trade-video-director.mjs catalog
  node trade-video-director.mjs lint /workspace/agent/projects/<slug>/storyboard.json
  node trade-video-director.mjs make --idea <idea-id> --strategy ma-cross --range 1y --render
  node trade-video-director.mjs make --title "Long copper supply squeeze" --asset COPPER --direction long --strategy breakout --range 1y --render
  node trade-video-director.mjs make --asset NVDA --direction long --title "Long NVDA compute demand" --no-tts

Options:
  --idea <id>            Use Analyst/Trade Idea OS idea id or prefix
  --asset <symbol>       Manual asset, e.g. NVDA, BTC, COPPER, USDJPY
  --direction <dir>      long, short, fade, underweight, neutral
  --title <text>         Manual video title
  --strategy <name>      Trade Lab template: ma-cross, breakout, rsi-mean-reversion, buy-hold, none
  --range <range>        Yahoo range passed to Trade Lab, default 1y
  --benchmark <symbol>   Optional benchmark/proxy
  --peers <list>         Optional peer/proxy list
  --theme <theme>        marex, clean, editorial
  --accent <#RRGGBB>     Accent color
  --slug <slug>          Project/output slug
  --render               Generate MP4 after building storyboard
  --no-tts               Skip narration audio generation
  --dry-run              Build files only; skip TTS and render
  --json                 Emit JSON
`);
}
