#!/usr/bin/env node
/**
 * Safe risk committee for Thedius Analyst.
 *
 * AutoHedge-inspired review pattern, implemented natively:
 * - fixed reviewer lenses
 * - Trade Lab as the only market-data/backtest input
 * - no broker endpoints
 * - no autonomous execution
 * - no generated strategy code
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

if (!command || command === 'help' || args.help || args.h) {
  printUsage();
  process.exit(0);
}

try {
  let result;
  if (command === 'review') result = await commandReview();
  else if (command === 'doctor') result = commandDoctor();
  else if (command === 'lenses') result = commandLenses();
  else throw new Error(`Unknown command: ${command}`);

  await emit(result);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

async function commandReview() {
  const ideaLab = args['lab-json']
    ? JSON.parse(await fs.readFile(path.resolve(args['lab-json']), 'utf8'))
    : runIdeaLab();
  const review = buildReview(ideaLab);

  if (args.save || args['out-dir']) {
    review.saved = await saveReview(review, args['out-dir'] || defaultOutDir());
  }

  return { kind: 'riskCommitteeReview', review };
}

function commandDoctor() {
  const checks = [
    checkPath('Trade Lab script', ideaLabPath()),
    checkCommand('node', false),
  ];
  const ok = checks.every((check) => check.ok || check.optional);
  return {
    kind: 'doctor',
    ok,
    checks,
    safety: safetyObject(),
  };
}

function commandLenses() {
  return {
    kind: 'lenses',
    lenses: [
      {
        name: 'bull-case',
        question: 'What supports the idea if the source thesis is right?',
      },
      {
        name: 'bear-case',
        question: 'What breaks the idea or makes it not worth more work?',
      },
      {
        name: 'macro-regime',
        question: 'Is the asset sitting in a supportive or hostile regime?',
      },
      {
        name: 'positioning-crowding',
        question: 'Is this just duplicated beta, momentum, or consensus exposure?',
      },
      {
        name: 'portfolio-fit',
        question: 'What would this do to concentration, beta, drawdown, and liquidity?',
      },
      {
        name: 'kill-criteria',
        question: 'What concrete facts would invalidate the idea?',
      },
    ],
    safety: safetyObject(),
  };
}

function runIdeaLab() {
  const labArgs = ['analyze', '--json', '--range', args.range || '1y', '--strategy', args.strategy || 'ma-cross'];
  if (args.idea) labArgs.push('--idea', args.idea);
  else {
    if (!args.asset) throw new Error('review requires --idea, --asset, or --lab-json');
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

function buildReview(ideaLab) {
  const selected = selectedBacktest(ideaLab);
  const baseline = ideaLab.backtests?.[0] || null;
  const symbol = ideaLab.instrument?.symbol || ideaLab.instrument?.input || 'UNKNOWN';
  const direction = ideaLab.input?.direction || 'view';
  const title = ideaLab.input?.title || `Trade idea: ${symbol}`;
  const support = supportScore(ideaLab, selected, baseline);
  const risk = riskScore(ideaLab, selected);
  const verdict = committeeVerdict(ideaLab, selected, support, risk);
  const generatedAt = new Date().toISOString();

  const lenses = [
    bullCaseLens(ideaLab, selected, baseline, support),
    bearCaseLens(ideaLab, selected, risk),
    macroRegimeLens(ideaLab),
    positioningCrowdingLens(ideaLab),
    portfolioFitLens(ideaLab),
    killCriteriaLens(ideaLab, selected),
  ];

  return {
    kind: 'riskCommittee',
    schemaVersion: 1,
    generatedAt,
    title,
    symbol,
    direction,
    verdict,
    scorecard: {
      supportScore: support.score,
      riskScore: risk.score,
      supportFlags: support.flags,
      riskFlags: risk.flags,
      confidence: confidenceLevel(ideaLab, selected),
    },
    sourceIdea: ideaLab.sourceIdea || null,
    ideaLabSummary: {
      asOf: ideaLab.asOf,
      range: ideaLab.input?.range || null,
      strategy: ideaLab.input?.strategy || null,
      latestPrice: ideaLab.latest?.price ?? null,
      latestChangePct: ideaLab.latest?.changePct ?? null,
      trendRegime: ideaLab.trend?.trendRegime || null,
      return21d: ideaLab.trend?.return21d ?? null,
      return63d: ideaLab.trend?.return63d ?? null,
      annualizedVol: ideaLab.risk?.annualizedVol ?? null,
      maxDrawdown: ideaLab.risk?.maxDrawdown ?? null,
      betaToBenchmark: ideaLab.risk?.betaToBenchmark ?? null,
      corrToBenchmark: ideaLab.risk?.corrToBenchmark ?? null,
      observations: ideaLab.risk?.observations ?? null,
      selectedTemplate: selected?.name || null,
      selectedSignal: selected?.latestSignalLabel || null,
      selectedReturn: selected?.totalReturn ?? null,
      selectedMaxDrawdown: selected?.maxDrawdown ?? null,
      selectedSharpe: selected?.sharpeRf0 ?? null,
    },
    lenses,
    decisionMemo: decisionMemo({ title, symbol, direction, verdict, ideaLab, selected, support, risk }),
    followUps: followUps(ideaLab, selected, verdict),
    safety: safetyObject(),
  };
}

function supportScore(ideaLab, selected, baseline) {
  const flags = [];
  let score = 0;
  const direction = String(ideaLab.input?.direction || '').toLowerCase();

  if (ideaLab.sourceIdea?.quote) {
    score += 1;
    flags.push('Source thesis is captured with a traceable quote.');
  }
  if (['uptrend', 'constructive'].includes(ideaLab.trend?.trendRegime)) {
    score += ideaLab.trend?.trendRegime === 'uptrend' ? 2 : 1;
    flags.push(`Trend is ${ideaLab.trend.trendRegime}.`);
  }
  if (directionAlignedReturn(direction, ideaLab.trend?.return21d)) {
    score += 1;
    flags.push(`21d return is directionally supportive: ${formatPct(ideaLab.trend.return21d)}.`);
  }
  if (directionAlignedReturn(direction, ideaLab.trend?.return63d)) {
    score += 1;
    flags.push(`63d return is directionally supportive: ${formatPct(ideaLab.trend.return63d)}.`);
  }
  if (selected?.latestSignalLabel && selected.latestSignalLabel !== 'flat') {
    score += directionSignalSupport(direction, selected.latestSignalLabel) ? 2 : 0;
    if (directionSignalSupport(direction, selected.latestSignalLabel)) {
      flags.push(`Selected template signal is supportive: ${selected.latestSignalLabel}.`);
    }
  }
  if (Number.isFinite(selected?.totalReturn) && selected.totalReturn > 0) {
    score += 1;
    flags.push(`Selected template return is positive: ${formatPct(selected.totalReturn)}.`);
  }
  if (Number.isFinite(selected?.sharpeRf0) && selected.sharpeRf0 > 0.5) {
    score += 1;
    flags.push(`Selected template Sharpe rf=0 is above 0.5: ${formatNumber(selected.sharpeRf0, 2)}.`);
  }
  if (selected && baseline && Number.isFinite(selected.totalReturn) && Number.isFinite(baseline.totalReturn)) {
    if (selected.totalReturn > baseline.totalReturn) {
      score += 1;
      flags.push('Selected template beats directional baseline in-sample.');
    }
  }

  return { score, flags };
}

function riskScore(ideaLab, selected) {
  const flags = [];
  let score = 0;
  const risk = ideaLab.risk || {};

  if (!Number.isFinite(risk.observations) || risk.observations < 120) {
    score += 1;
    flags.push(`Short sample: ${risk.observations ?? 0} observations.`);
  }
  if (Number.isFinite(risk.annualizedVol) && risk.annualizedVol > 0.45) {
    score += 2;
    flags.push(`Very high annualized vol: ${formatPct(risk.annualizedVol)}.`);
  } else if (Number.isFinite(risk.annualizedVol) && risk.annualizedVol > 0.3) {
    score += 1;
    flags.push(`High annualized vol: ${formatPct(risk.annualizedVol)}.`);
  }
  if (Number.isFinite(risk.maxDrawdown) && risk.maxDrawdown < -0.3) {
    score += 2;
    flags.push(`Large sample max drawdown: ${formatPct(risk.maxDrawdown)}.`);
  } else if (Number.isFinite(risk.maxDrawdown) && risk.maxDrawdown < -0.15) {
    score += 1;
    flags.push(`Meaningful sample max drawdown: ${formatPct(risk.maxDrawdown)}.`);
  }
  if (Number.isFinite(risk.betaToBenchmark) && Math.abs(risk.betaToBenchmark) > 2) {
    score += 2;
    flags.push(`Very high benchmark beta: ${formatNumber(risk.betaToBenchmark, 2)}.`);
  } else if (Number.isFinite(risk.betaToBenchmark) && Math.abs(risk.betaToBenchmark) > 1.5) {
    score += 1;
    flags.push(`High benchmark beta: ${formatNumber(risk.betaToBenchmark, 2)}.`);
  }
  if (Number.isFinite(risk.corrToBenchmark) && Math.abs(risk.corrToBenchmark) > 0.75) {
    score += 1;
    flags.push(`High benchmark correlation: ${formatNumber(risk.corrToBenchmark, 2)}.`);
  }
  if (selected?.latestSignalLabel === 'flat') {
    score += 1;
    flags.push('Selected template is flat now.');
  }
  if (Number.isFinite(selected?.totalReturn) && selected.totalReturn < 0) {
    score += 2;
    flags.push(`Selected template return is negative: ${formatPct(selected.totalReturn)}.`);
  }
  if (Number.isFinite(selected?.maxDrawdown) && selected.maxDrawdown < -0.15) {
    score += 1;
    flags.push(`Selected template drawdown is material: ${formatPct(selected.maxDrawdown)}.`);
  }
  if (Number.isFinite(selected?.trades) && selected.trades < 2 && selected.name !== 'buy-hold') {
    score += 1;
    flags.push('Template has too few trades to trust.');
  }

  return { score, flags };
}

function committeeVerdict(ideaLab, selected, support, risk) {
  const criticalReject =
    Number.isFinite(selected?.totalReturn) && selected.totalReturn < -0.08 ||
    ['downtrend', 'weak'].includes(ideaLab.trend?.trendRegime) && !directionSignalSupport(ideaLab.input?.direction, selected?.latestSignalLabel);
  if (criticalReject || support.score <= 2 && risk.score >= 5) {
    return {
      label: 'reject',
      meaning: 'Do not spend more work on this unless new evidence arrives.',
      ledgerStatusSuggestion: 'rejected',
      confidence: confidenceLevel(ideaLab, selected),
    };
  }

  if (support.score >= 7 && risk.score <= 2 && Number(ideaLab.risk?.observations || 0) >= 180) {
    return {
      label: 'pass',
      meaning: 'Pass to deeper human/Analyst work. This is not permission to trade.',
      ledgerStatusSuggestion: 'watch',
      confidence: confidenceLevel(ideaLab, selected),
    };
  }

  return {
    label: 'watch',
    meaning: 'Plausible, but needs confirmation or risk reduction before deeper commitment.',
    ledgerStatusSuggestion: 'watch',
    confidence: confidenceLevel(ideaLab, selected),
  };
}

function bullCaseLens(ideaLab, selected, baseline, support) {
  const findings = [...support.flags];
  if (baseline?.totalReturn != null) findings.push(`Directional baseline return: ${formatPct(baseline.totalReturn)}.`);
  return lens('Bull Case', 'supportive', findings.slice(0, 5), [
    'The source thesis must remain intact.',
    'The template signal must not flip against the idea.',
  ]);
}

function bearCaseLens(ideaLab, selected, risk) {
  const findings = risk.flags.length ? risk.flags : ['No major mechanical risk flags from Trade Lab, but this is still a narrow price-data check.'];
  return lens('Bear Case', risk.score >= 5 ? 'hostile' : 'caution', findings.slice(0, 6), [
    'Price-data support is not the same as fundamental confirmation.',
    'A source-mentioned idea can be directionally right and still be untradeable due to path risk.',
  ]);
}

function macroRegimeLens(ideaLab) {
  const assetClass = ideaLab.instrument?.assetClass || 'unknown';
  const findings = [];
  if (assetClass === 'equity') {
    findings.push(`Equity beta regime: beta ${formatNumber(ideaLab.risk?.betaToBenchmark, 2)} to ${ideaLab.benchmark?.symbol || 'benchmark'}.`);
    findings.push('Check rates, earnings revisions, liquidity, and index risk before sizing.');
  } else if (assetClass === 'commodity') {
    findings.push('Commodity regime requires supply/demand, inventory, curve shape, USD, and geopolitical checks.');
  } else if (assetClass === 'fx') {
    findings.push('FX regime requires rate differentials, policy reaction function, current account, and positioning checks.');
  } else if (assetClass === 'crypto') {
    findings.push('Crypto regime requires liquidity, ETF flows, leverage, and regulatory/event-risk checks.');
  } else {
    findings.push(`Asset class ${assetClass}; macro checks need manual tailoring.`);
  }
  return lens('Macro / Regime', 'incomplete', findings, [
    'Trade Lab is price/risk only; macro regime must be confirmed separately.',
  ]);
}

function positioningCrowdingLens(ideaLab) {
  const findings = [];
  if (Number.isFinite(ideaLab.risk?.corrToBenchmark) && Math.abs(ideaLab.risk.corrToBenchmark) > 0.65) {
    findings.push(`High benchmark correlation means this may be duplicated beta: ${formatNumber(ideaLab.risk.corrToBenchmark, 2)}.`);
  }
  if (Number.isFinite(ideaLab.risk?.betaToBenchmark) && Math.abs(ideaLab.risk.betaToBenchmark) > 1.3) {
    findings.push(`High beta means portfolio P/L may be driven more by market regime than thesis: ${formatNumber(ideaLab.risk.betaToBenchmark, 2)}.`);
  }
  findings.push('No live positioning, borrow, options skew, or flow data is included in this committee run.');
  return lens('Positioning / Crowding', findings.length > 1 ? 'caution' : 'incomplete', findings, [
    'Check CFTC/prime/ETF/options/short-interest data where relevant.',
  ]);
}

function portfolioFitLens(ideaLab) {
  const findings = [];
  const vol = ideaLab.risk?.annualizedVol;
  const dd = ideaLab.risk?.maxDrawdown;
  if (Number.isFinite(vol)) findings.push(`Annualized vol: ${formatPct(vol)}.`);
  if (Number.isFinite(dd)) findings.push(`Sample max drawdown: ${formatPct(dd)}.`);
  if (Number.isFinite(ideaLab.risk?.betaToBenchmark)) findings.push(`Benchmark beta: ${formatNumber(ideaLab.risk.betaToBenchmark, 2)}.`);
  findings.push('No portfolio weights were supplied; fit is exposure-framing only.');
  return lens('Portfolio Fit', Number(vol) > 0.35 || Number(dd) < -0.2 ? 'caution' : 'neutral', findings, [
    'Run portfolio-level risk if Ilan supplies current weights or target exposure.',
  ]);
}

function killCriteriaLens(ideaLab, selected) {
  const direction = String(ideaLab.input?.direction || '').toLowerCase();
  const symbol = ideaLab.instrument?.symbol || 'asset';
  const criteria = [];
  if (direction.includes('long') || direction.includes('bull')) {
    criteria.push(`${symbol} loses 50-day trend support and the selected template flips flat/short.`);
    criteria.push('The source catalyst weakens: demand, capex, supply squeeze, policy, or earnings revisions stop confirming.');
  } else if (direction.includes('short') || direction.includes('under') || direction.includes('fade')) {
    criteria.push(`${symbol} regains trend support and the selected template flips long.`);
    criteria.push('The supposed overextension/crowding signal normalizes without price damage.');
  } else {
    criteria.push(`${symbol} moves against the thesis and the selected template stops confirming.`);
  }
  if (Number.isFinite(selected?.maxDrawdown)) {
    criteria.push(`Template drawdown worsens beyond current sample drawdown of ${formatPct(selected.maxDrawdown)}.`);
  }
  criteria.push('New source evidence contradicts the original thesis.');
  return lens('Kill Criteria', 'required', criteria, [
    'These are research invalidation checks, not automated stops.',
  ]);
}

function lens(name, stance, findings, caveats = []) {
  return { name, stance, findings: findings.filter(Boolean), caveats };
}

function decisionMemo({ title, symbol, direction, verdict, ideaLab, selected, support, risk }) {
  const source = ideaLab.sourceIdea?.source || 'Manual idea';
  const quote = ideaLab.sourceIdea?.quote || ideaLab.input?.title || title;
  return {
    bottomLine: `${verdict.label.toUpperCase()}: ${verdict.meaning}`,
    thesis: `${symbol} ${direction}. Source: ${source}.`,
    sourceLine: truncateText(quote, 420),
    tape: `Latest ${formatMoney(ideaLab.latest?.price, ideaLab.latest?.currency)}; trend ${ideaLab.trend?.trendRegime || 'n/a'}; 21d ${formatPct(ideaLab.trend?.return21d)}; 63d ${formatPct(ideaLab.trend?.return63d)}.`,
    template: selected
      ? `${selected.name}: signal ${selected.latestSignalLabel}, return ${formatPct(selected.totalReturn)}, Sharpe ${formatNumber(selected.sharpeRf0, 2)}, max DD ${formatPct(selected.maxDrawdown)}.`
      : 'No selected template.',
    risk: `Vol ${formatPct(ideaLab.risk?.annualizedVol)}, max DD ${formatPct(ideaLab.risk?.maxDrawdown)}, beta ${formatNumber(ideaLab.risk?.betaToBenchmark, 2)}, corr ${formatNumber(ideaLab.risk?.corrToBenchmark, 2)}.`,
    score: `Support ${support.score}; risk ${risk.score}; confidence ${verdict.confidence}.`,
  };
}

function followUps(ideaLab, selected, verdict) {
  const base = [
    'Confirm the source thesis with primary/source-level evidence.',
    'Define horizon, catalyst timing, and invalidation before any status promotion.',
    'Check liquidity, borrow/options availability, and event calendar.',
  ];
  if (ideaLab.instrument?.assetClass === 'equity') {
    base.push('Check earnings revisions, valuation, margins, and management guidance.');
  }
  if (Number.isFinite(ideaLab.risk?.betaToBenchmark) && Math.abs(ideaLab.risk.betaToBenchmark) > 1.3) {
    base.push('Run portfolio risk to see whether this duplicates existing beta.');
  }
  if (verdict.label === 'reject') {
    base.push('Only reopen if new evidence changes the source thesis or the tape flips.');
  }
  return base.slice(0, 6);
}

async function saveReview(review, outDir) {
  const resolvedOutDir = path.resolve(outDir);
  await fs.mkdir(resolvedOutDir, { recursive: true });
  const stamp = review.generatedAt.replace(/[:.]/g, '-');
  const slug = slugify(`${review.symbol}-${review.verdict.label}-${review.title}`).slice(0, 120);
  const jsonPath = path.join(resolvedOutDir, `${stamp}-${slug}.json`);
  const markdownPath = path.join(resolvedOutDir, `${stamp}-${slug}.md`);
  await fs.writeFile(jsonPath, `${JSON.stringify({ ...review, saved: undefined }, null, 2)}\n`, 'utf8');
  await fs.writeFile(markdownPath, renderReviewMarkdown({ ...review, saved: undefined }), 'utf8');
  return { jsonPath, markdownPath };
}

function selectedBacktest(ideaLab) {
  const strategy = ideaLab.input?.strategy;
  return ideaLab.backtests?.find((item) => item.name === strategy) || ideaLab.backtests?.[1] || ideaLab.backtests?.[0] || null;
}

function directionAlignedReturn(direction, value) {
  if (!Number.isFinite(value)) return false;
  const d = String(direction || '').toLowerCase();
  if (d.includes('short') || d.includes('under') || d.includes('fade')) return value < 0;
  return value > 0;
}

function directionSignalSupport(direction, signal) {
  const d = String(direction || '').toLowerCase();
  const s = String(signal || '').toLowerCase();
  if (!s || s === 'flat') return false;
  if (d.includes('short') || d.includes('under') || d.includes('fade')) return s.includes('short');
  if (d.includes('long') || d.includes('bull') || d === 'turning-long') return s.includes('long');
  return s !== 'flat';
}

function confidenceLevel(ideaLab, selected) {
  const observations = Number(ideaLab.risk?.observations || 0);
  if (observations >= 220 && selected && Number.isFinite(selected.totalReturn) && ideaLab.sourceIdea?.quote) return 'moderate';
  if (observations >= 100) return 'low-moderate';
  return 'low';
}

function safetyObject() {
  return {
    importedAutoHedgeCode: false,
    brokerEndpoints: false,
    orderExecution: false,
    autonomousTrading: false,
    generatedStrategyCodeExecution: false,
    tradeLabTemplatesOnly: true,
  };
}

function checkPath(label, targetPath, optional = false) {
  return { label, path: targetPath, ok: existsSync(targetPath), optional };
}

function checkCommand(name, optional = true) {
  const result = spawnSync('which', [name], { encoding: 'utf8' });
  return { label: `Command: ${name}`, path: result.stdout.trim() || null, ok: result.status === 0, optional };
}

function ideaLabPath() {
  const containerPath = '/app/skills/finance-analyst/scripts/idea-lab.mjs';
  if (existsSync(containerPath)) return containerPath;
  return path.resolve(__dirname, '..', '..', 'finance-analyst', 'scripts', 'idea-lab.mjs');
}

function defaultOutDir() {
  if (existsSync('/workspace/agent')) return '/workspace/agent/risk-committee';
  return path.join(process.cwd(), 'groups', 'thedius_analyst', 'risk-committee');
}

async function emit(result) {
  if (args.out) {
    const outPath = path.resolve(args.out);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderMarkdown(result));
}

function renderMarkdown(result) {
  if (result.kind === 'doctor') {
    return [
      '# Risk Committee Doctor',
      '',
      `Status: ${result.ok ? 'ok' : 'needs attention'}`,
      '',
      table(
        ['Check', 'OK', 'Path'],
        result.checks.map((check) => [check.label, check.ok ? 'yes' : check.optional ? 'optional missing' : 'no', check.path || '']),
      ),
      '',
      'Safety: no AutoHedge code, no broker endpoints, no order execution.',
    ].join('\n');
  }
  if (result.kind === 'lenses') {
    return [
      '# Risk Committee Lenses',
      '',
      table(
        ['Lens', 'Question'],
        result.lenses.map((item) => [item.name, item.question]),
      ),
      '',
      'Safety: fixed lenses only; no autonomous execution.',
    ].join('\n');
  }
  if (result.kind === 'riskCommitteeReview') return renderReviewMarkdown(result.review);
  return JSON.stringify(result, null, 2);
}

function renderReviewMarkdown(review) {
  const lines = [
    `# Risk Committee: ${review.title}`,
    '',
    `Generated: ${review.generatedAt}`,
    `Symbol: ${review.symbol}`,
    `Verdict: ${review.verdict.label.toUpperCase()} — ${review.verdict.meaning}`,
    `Suggested ledger status: ${review.verdict.ledgerStatusSuggestion}`,
    `Confidence: ${review.scorecard.confidence}`,
    '',
    '## Decision Memo',
    '',
    `- Bottom line: ${review.decisionMemo.bottomLine}`,
    `- Thesis: ${review.decisionMemo.thesis}`,
    `- Source: ${review.decisionMemo.sourceLine}`,
    `- Tape: ${review.decisionMemo.tape}`,
    `- Template: ${review.decisionMemo.template}`,
    `- Risk: ${review.decisionMemo.risk}`,
    `- Score: ${review.decisionMemo.score}`,
    '',
    '## Lens Reviews',
    '',
  ];

  for (const item of review.lenses) {
    lines.push(`### ${item.name} (${item.stance})`, '');
    for (const finding of item.findings) lines.push(`- ${finding}`);
    for (const caveat of item.caveats || []) lines.push(`- Caveat: ${caveat}`);
    lines.push('');
  }

  lines.push('## Follow-ups', '');
  for (const item of review.followUps) lines.push(`- ${item}`);
  lines.push('', '## Safety', '');
  lines.push('- No AutoHedge code imported.');
  lines.push('- No broker endpoints or order execution.');
  lines.push('- No generated strategy code.');
  lines.push('- Trade Lab fixed templates only.');
  if (review.saved?.markdownPath) lines.push(`- Saved markdown: ${review.saved.markdownPath}`);
  if (review.saved?.jsonPath) lines.push(`- Saved JSON: ${review.saved.jsonPath}`);
  return lines.join('\n');
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

function slugify(value) {
  return String(value || 'risk-committee')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 140);
}

function truncateText(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
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

function printUsage() {
  console.log(`Usage:
  node risk-committee.mjs doctor
  node risk-committee.mjs lenses
  node risk-committee.mjs review --idea <idea-id> --strategy ma-cross --range 1y --save
  node risk-committee.mjs review --title "Long copper supply squeeze" --asset COPPER --direction long --strategy breakout --range 1y --save
  node risk-committee.mjs review --lab-json /workspace/agent/trade-lab/run.json --save

Options:
  --idea <id>            Use Trade Idea OS idea id or prefix
  --asset <symbol>       Manual asset, e.g. NVDA, BTC, COPPER, USDJPY
  --direction <dir>      long, short, fade, underweight, neutral
  --title <text>         Manual title
  --strategy <name>      Trade Lab template: ma-cross, breakout, rsi-mean-reversion, buy-hold, none
  --range <range>        Yahoo range passed to Trade Lab, default 1y
  --benchmark <symbol>   Optional benchmark/proxy
  --peers <list>         Optional peer/proxy list
  --lab-json <path>      Reuse an existing Trade Lab JSON output
  --save                 Save markdown and JSON memo
  --out-dir <path>       Save memo to a specific directory
  --out <path>           Also write JSON to a specific file
  --json                 Emit JSON
`);
}
