#!/usr/bin/env node
/**
 * Local trade idea ledger for Thedius Analyst.
 *
 * Stores source-mentioned ideas, Analyst overlays, status, follow-ups, and
 * outcome notes in one JSON file. No network access and no dependencies.
 */
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';

const rawArgs = process.argv.slice(2).filter((arg) => arg !== '--');
const command = rawArgs.shift();
const args = parseArgs(rawArgs);
const ledgerPath = path.resolve(args.ledger || process.env.TRADE_IDEA_LEDGER || defaultLedgerPath());

if (!command || command === 'help' || args.help || args.h) {
  printUsage();
  process.exit(0);
}

try {
  let result;
  if (command === 'init') result = await commandInit();
  else if (command === 'add') result = await commandAdd();
  else if (command === 'import-digest') result = await commandImportDigest(positionals(args)[0]);
  else if (command === 'list') result = await commandList();
  else if (command === 'brief') result = await commandBrief();
  else if (command === 'update') result = await commandUpdate(positionals(args)[0]);
  else throw new Error(`Unknown command: ${command}`);

  await emit(result);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

async function commandInit() {
  if (existsSync(ledgerPath) && !args.force) {
    const ledger = await loadLedger();
    return { kind: 'init', path: ledgerPath, created: false, ideaCount: ledger.ideas.length };
  }
  const ledger = emptyLedger();
  await saveLedger(ledger);
  return { kind: 'init', path: ledgerPath, created: true, ideaCount: 0 };
}

async function commandAdd() {
  const ledger = await loadLedger();
  const fromJson = args['from-json'] ? JSON.parse(await fs.readFile(args['from-json'], 'utf8')) : {};
  const data = { ...fromJson, ...cliIdeaFields() };
  if (!data.title) throw new Error('add requires --title or --from-json with title');

  const now = new Date().toISOString();
  const idea = {
    id: data.id || makeIdeaId(now),
    createdAt: data.createdAt || now,
    updatedAt: now,
    status: data.status || 'triage',
    title: data.title,
    sourceType: data.sourceType || data['source-type'] || 'manual',
    source: data.source || null,
    sourceDate: data.sourceDate || data['source-date'] || null,
    sourceUrl: data.sourceUrl || data['source-url'] || null,
    sourcePath: data.sourcePath || data['source-path'] || null,
    quote: data.quote || null,
    asset: data.asset || null,
    direction: data.direction || null,
    expression: data.expression || null,
    horizon: data.horizon || null,
    catalyst: data.catalyst || null,
    thesis: data.thesis || null,
    analystView: data.analystView || data['analyst-view'] || null,
    invalidation: data.invalidation || null,
    conviction: data.conviction || null,
    followUpDate: data.followUpDate || data['follow-up'] || null,
    tags: parseTags(data.tags),
    notes: parseNotes(data.notes || data.note),
    history: [{ at: now, action: 'created', status: data.status || 'triage' }],
  };

  ledger.ideas.unshift(idea);
  ledger.updatedAt = now;
  await saveLedger(ledger);
  return { kind: 'add', path: ledgerPath, idea };
}

async function commandImportDigest(filePath) {
  if (!filePath) throw new Error('import-digest requires a markdown file path');
  const sourcePath = path.resolve(filePath);
  const markdown = await fs.readFile(sourcePath, 'utf8');
  const ledger = await loadLedger();
  const candidates = parseDigestIdeas(markdown, sourcePath);
  const now = new Date().toISOString();

  if (args['dry-run']) {
    return { kind: 'importDigest', dryRun: true, sourcePath, candidates };
  }

  const existingKeys = new Set(ledger.ideas.map((idea) => idea.sourceKey || sourceKey(idea)));
  const added = [];
  for (const candidate of candidates) {
    const key = sourceKey(candidate);
    if (existingKeys.has(key)) continue;
    const idea = {
      ...candidate,
      id: makeIdeaId(now),
      createdAt: now,
      updatedAt: now,
      status: args.status || 'triage',
      sourceKey: key,
      history: [{ at: now, action: 'imported-digest', status: args.status || 'triage' }],
    };
    ledger.ideas.unshift(idea);
    added.push(idea);
  }
  ledger.updatedAt = now;
  await saveLedger(ledger);
  return { kind: 'importDigest', sourcePath, addedCount: added.length, skippedCount: candidates.length - added.length, added };
}

async function commandList() {
  const ledger = await loadLedger();
  const ideas = filterIdeas(ledger.ideas).slice(0, Number(args.limit || 20));
  return { kind: 'list', path: ledgerPath, ideas, total: ideas.length, ledgerUpdatedAt: ledger.updatedAt };
}

async function commandBrief() {
  const ledger = await loadLedger();
  const ideas = filterIdeas(ledger.ideas);
  const groups = {};
  for (const idea of ideas) {
    const status = idea.status || 'triage';
    if (!groups[status]) groups[status] = [];
    groups[status].push(idea);
  }
  return { kind: 'brief', path: ledgerPath, groups, total: ideas.length, ledgerUpdatedAt: ledger.updatedAt };
}

async function commandUpdate(id) {
  if (!id) throw new Error('update requires an idea id');
  const ledger = await loadLedger();
  const idea = ledger.ideas.find((item) => item.id === id || item.id.startsWith(id));
  if (!idea) throw new Error(`Idea not found: ${id}`);

  const now = new Date().toISOString();
  const changes = {};
  const mapping = {
    status: 'status',
    expression: 'expression',
    horizon: 'horizon',
    catalyst: 'catalyst',
    thesis: 'thesis',
    invalidation: 'invalidation',
    conviction: 'conviction',
    outcome: 'outcome',
    'follow-up': 'followUpDate',
    'analyst-view': 'analystView',
    'live-price': 'livePrice',
  };

  for (const [argName, fieldName] of Object.entries(mapping)) {
    if (args[argName] !== undefined) {
      idea[fieldName] = args[argName];
      changes[fieldName] = args[argName];
    }
  }

  if (args.tags !== undefined) {
    idea.tags = parseTags(args.tags);
    changes.tags = idea.tags;
  }
  if (args['add-note']) {
    idea.notes = Array.isArray(idea.notes) ? idea.notes : [];
    idea.notes.push({ at: now, text: args['add-note'] });
    changes.note = args['add-note'];
  }

  idea.updatedAt = now;
  idea.history = Array.isArray(idea.history) ? idea.history : [];
  idea.history.push({ at: now, action: 'updated', changes });
  ledger.updatedAt = now;
  await saveLedger(ledger);
  return { kind: 'update', path: ledgerPath, idea, changes };
}

function cliIdeaFields() {
  const fields = [
    'id',
    'title',
    'status',
    'source',
    'source-type',
    'source-date',
    'source-url',
    'source-path',
    'quote',
    'asset',
    'direction',
    'expression',
    'horizon',
    'catalyst',
    'thesis',
    'analyst-view',
    'invalidation',
    'conviction',
    'follow-up',
    'tags',
    'note',
  ];
  return Object.fromEntries(fields.filter((field) => args[field] !== undefined).map((field) => [field, args[field]]));
}

function parseDigestIdeas(markdown, sourcePath) {
  const relevantMarkdown = markdown.split(/^##\s+(?:Gated out|Tally|Transcript gaps)/im)[0];
  const lines = relevantMarkdown.split(/\r?\n/);
  const digestTitle = lines.find((line) => line.startsWith('# '))?.replace(/^#\s+/, '').trim() || path.basename(sourcePath);
  const sourceType = inferDigestSourceType(digestTitle, sourcePath);
  const sourceTag = sourceType === 'inbox-digest' ? 'inbox' : 'pod';
  const out = [];
  let lastSourceUrl = null;

  for (let i = 0; i < lines.length; i += 1) {
    const legacyMatch = lines[i].match(/^- \*\*(.+?)\*\*(?:\s+[—-]\s+(.+))?/);
    const standaloneMatch = lines[i].match(/^\*\*(.+?)\*\*\s*$/);
    if (!legacyMatch && !standaloneMatch) continue;

    const { nearbyLines, nextIndex } = collectDigestCardLines(lines, i);
    const candidate = legacyMatch
      ? parseLegacyDigestCard(legacyMatch, nearbyLines, {
          digestTitle,
          sourcePath,
          sourceType,
          sourceTag,
        })
      : parseThreeLineDigestCard(standaloneMatch, nearbyLines, {
          digestTitle,
          sourcePath,
          sourceType,
          sourceTag,
          lastSourceUrl,
        });

    if (candidate) {
      if (candidate.sourceUrl) lastSourceUrl = candidate.sourceUrl;
      out.push(candidate);
    }

    i = nextIndex - 1;
  }
  return out;
}

function collectDigestCardLines(lines, startIndex) {
  const nearbyLines = [];
  let nextIndex = startIndex + 1;
  for (; nextIndex < lines.length; nextIndex += 1) {
    if (isDigestCardStart(lines[nextIndex]) || /^##\s+/.test(lines[nextIndex])) break;
    nearbyLines.push(lines[nextIndex]);
  }
  return { nearbyLines, nextIndex };
}

function isDigestCardStart(line) {
  return /^- \*\*.+?\*\*/.test(line) || /^\*\*.+?\*\*\s*$/.test(line);
}

function parseLegacyDigestCard(match, nearbyLines, context) {
  const nearby = nearbyLines.join(' ');
  if (/framing only/i.test(nearby)) return null;
  const quoteLine = nearbyLines.find((line) => /^\s*-\s*Quote:/i.test(line));
  const quote =
    quoteLine
      ?.replace(/^\s*-\s*Quote:\s*/i, '')
      .replace(/^"/, '')
      .replace(/"$/, '')
      .trim() ||
    nearby.match(/"([^"]{12,1000})"/)?.[1] ||
    null;
  const sourceLine =
    (match[2] || '').replace(/:\s*$/, '').trim() ||
    nearby.match(/(?:Source|Sources):\s*([^"]+?)(?:Evidence:|So what:|$)/i)?.[1]?.trim() ||
    null;
  const sourceUrl = extractSourceUrl(nearby);
  const inferred = inferIdeaFields(match[1]);
  return makeDigestIdea({
    title: match[1].trim(),
    thesis: match[2]?.trim() || null,
    source: sourceLine ? cleanSourceLine(sourceLine) : context.digestTitle,
    sourceDate: extractSourceDate(sourceLine || nearby),
    sourceUrl,
    quote,
    inferred,
    context,
  });
}

function parseThreeLineDigestCard(match, nearbyLines, context) {
  const nearby = nearbyLines.join(' ');
  if (/framing only/i.test(nearby)) return null;

  const bulletLines = nearbyLines.map((line) => line.replace(/^\s*-\s*/, '').trim()).filter(Boolean);
  const thesis = bulletLines[0] || null;
  const sourceLine = bulletLines.find((line, index) => index > 0 && looksLikeSourceLine(line)) || bulletLines[1] || null;
  const sourceUrl = extractSourceUrl(sourceLine) || (/\bsame URL\b/i.test(sourceLine || '') ? context.lastSourceUrl : null);
  const inferred = inferIdeaFields(match[1]);

  return makeDigestIdea({
    title: match[1].trim(),
    thesis,
    source: sourceLine ? cleanSourceLine(sourceLine) : context.digestTitle,
    sourceDate: extractSourceDate(sourceLine),
    sourceUrl,
    quote: null,
    inferred,
    context,
  });
}

function makeDigestIdea({ title, thesis, source, sourceDate, sourceUrl, quote, inferred, context }) {
  return {
    title,
    thesis,
    sourceType: context.sourceType,
    source,
    sourceDate,
    sourceUrl,
    sourcePath: context.sourcePath,
    quote,
    asset: inferred.asset,
    direction: inferred.direction,
    expression: null,
    horizon: null,
    catalyst: null,
    analystView: null,
    invalidation: null,
    conviction: null,
    tags: [context.sourceTag, 'source-mentioned'],
    notes: [],
  };
}

function inferDigestSourceType(digestTitle, sourcePath) {
  const text = `${digestTitle} ${sourcePath}`.toLowerCase();
  return text.includes('inbox') ? 'inbox-digest' : 'pod-digest';
}

function looksLikeSourceLine(line) {
  return /https?:\/\//i.test(line) || /\bsame URL\b/i.test(line) || /\(\d{4}-\d{2}-\d{2}\)/.test(line);
}

function extractSourceUrl(value) {
  return String(value || '').match(/https?:\/\/\S+/i)?.[0]?.replace(/[),.;'"]+$/, '') || null;
}

function extractSourceDate(value) {
  return String(value || '').match(/\((\d{4}-\d{2}-\d{2})\)/)?.[1] || null;
}

function cleanSourceLine(value) {
  return String(value || '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\bsame URL\b\.?/gi, '')
    .replace(/\s*[—-]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferIdeaFields(title) {
  const rawTitle = String(title || '');
  const text = rawTitle.toLowerCase();
  const parenthetical = normalizeParentheticalAsset(rawTitle.match(/\(([^)]{2,160})\)/)?.[1]);
  const assets = [
    ['akamai', 'AKAM'],
    ['applied materials', 'AMAT'],
    ['cerebras', 'CBRS'],
    ['nebius', 'NBIS'],
    ['alphabet', 'GOOGL'],
    ['google', 'GOOGL'],
    ['nvidia', 'NVDA'],
    ['apple', 'AAPL'],
    ['bitcoin', 'BTC'],
    ['ethereum', 'ETH'],
    ['z.cash', 'ZEC'],
    ['zcash', 'ZEC'],
    ['chips + energy', 'SEMIS/POWER'],
    ['chips/memory', 'SEMIS/MEMORY'],
    ['memory chip', 'MEMORY'],
    ['risk-asset', 'RISK_ASSETS'],
    ['risk assets', 'RISK_ASSETS'],
    ['gold and silver', 'GOLD/SILVER'],
    ['dollar/yen', 'USDJPY'],
    ['dollar-yen', 'USDJPY'],
    ['vix', 'VIX'],
    ['copper', 'COPPER'],
    ['gold', 'GOLD'],
    ['silver', 'SILVER'],
    ['oil', 'OIL'],
    ['bonds', 'BONDS'],
    ['bond', 'BONDS'],
    ['dollar', 'USD'],
    ['intel', 'INTC'],
  ];
  const directions = [
    ['short-term dollar weakness story is "ending"', 'turning-long'],
    ['reduced size on long', 'reduced-long'],
    ['long vix', 'long'],
    ['long oil', 'long'],
    ['long risk', 'long'],
    ['long copper', 'long'],
    ['continued long', 'long'],
    ['watch', 'watch'],
    ['skip', 'avoid'],
    ['skeptical', 'underweight'],
    ['fade', 'fade'],
    ['long', 'long'],
    ['short', 'short'],
    ['upside', 'long'],
    ['weakness', 'short'],
  ];
  const direction = /^cap\b/.test(text) ? 'cap' : directions.find(([needle]) => text.includes(needle))?.[1] || null;
  return {
    asset: parenthetical || assets.find(([needle]) => text.includes(needle))?.[1] || null,
    direction,
  };
}

function normalizeParentheticalAsset(value) {
  const text = String(value || '').trim();
  if (!text || /no instrument|size reduced|back-end of the curve/i.test(text)) return null;
  return text.replace(/\s+long,\s*but\s*watch$/i, '').trim() || null;
}

function filterIdeas(ideas) {
  let out = [...ideas];
  if (args.status) out = out.filter((idea) => String(idea.status || '').toLowerCase() === String(args.status).toLowerCase());
  if (args.asset) out = out.filter((idea) => contains(idea.asset, args.asset) || contains(idea.title, args.asset));
  if (args.tag) out = out.filter((idea) => (idea.tags || []).some((tag) => contains(tag, args.tag)));
  if (args.q) out = out.filter((idea) => JSON.stringify(idea).toLowerCase().includes(String(args.q).toLowerCase()));
  return out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

async function loadLedger() {
  if (!existsSync(ledgerPath)) return emptyLedger();
  const ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
  return {
    schemaVersion: 1,
    createdAt: ledger.createdAt || new Date().toISOString(),
    updatedAt: ledger.updatedAt || ledger.createdAt || new Date().toISOString(),
    ideas: Array.isArray(ledger.ideas) ? ledger.ideas : [],
  };
}

async function saveLedger(ledger) {
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fs.writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
}

async function emit(result) {
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderMarkdown(result));
}

function renderMarkdown(result) {
  if (result.kind === 'init') {
    return `${result.created ? 'Created' : 'Found'} trade idea ledger: ${result.path}\nIdeas: ${result.ideaCount}`;
  }

  if (result.kind === 'add') {
    return [`# Added Trade Idea`, '', `ID: ${result.idea.id}`, `Title: ${result.idea.title}`, `Status: ${result.idea.status}`].join(
      '\n',
    );
  }

  if (result.kind === 'update') {
    return [`# Updated Trade Idea`, '', `ID: ${result.idea.id}`, `Title: ${result.idea.title}`, `Status: ${result.idea.status}`].join(
      '\n',
    );
  }

  if (result.kind === 'importDigest') {
    if (result.dryRun) {
      return [
        '# Digest Import Preview',
        '',
        `Source: ${result.sourcePath}`,
        '',
        table(
          ['Title', 'Source', 'Quote'],
          result.candidates.map((idea) => [idea.title, idea.source || '', truncate(idea.quote || '', 80)]),
        ),
      ].join('\n');
    }
    return [`# Imported Digest`, '', `Added: ${result.addedCount}`, `Skipped duplicates: ${result.skippedCount}`].join('\n');
  }

  if (result.kind === 'list') {
    return [
      '# Trade Ideas',
      '',
      `Ledger: ${result.path}`,
      '',
      table(
        ['ID', 'Status', 'Asset', 'Dir', 'Title', 'Follow-up'],
        result.ideas.map((idea) => [
          idea.id,
          idea.status || '',
          idea.asset || '',
          idea.direction || '',
          truncate(idea.title || '', 64),
          idea.followUpDate || '',
        ]),
      ),
    ].join('\n');
  }

  if (result.kind === 'brief') {
    const sections = ['# Trade Idea Board', '', `Ledger: ${result.path}`, `Ideas shown: ${result.total}`, ''];
    for (const status of Object.keys(result.groups).sort()) {
      sections.push(`## ${status}`, '');
      sections.push(
        table(
          ['ID', 'Asset', 'Dir', 'Title', 'Next'],
          result.groups[status].map((idea) => [
            idea.id,
            idea.asset || '',
            idea.direction || '',
            truncate(idea.title || '', 68),
            idea.followUpDate || '',
          ]),
        ),
        '',
      );
    }
    return sections.join('\n');
  }

  return JSON.stringify(result, null, 2);
}

function emptyLedger() {
  const now = new Date().toISOString();
  return { schemaVersion: 1, createdAt: now, updatedAt: now, ideas: [] };
}

function makeIdeaId(now) {
  return `idea-${now.slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 8)}`;
}

function defaultLedgerPath() {
  if (existsSync('/workspace/agent')) return '/workspace/agent/trade-ideas/ledger.json';
  return path.join(process.cwd(), 'groups', 'thedius_analyst', 'trade-ideas', 'ledger.json');
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

function parseTags(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return String(value || '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function parseNotes(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return [{ at: new Date().toISOString(), text: String(value) }];
}

function sourceKey(idea) {
  return [idea.title, idea.source, idea.sourcePath, idea.quote].map((item) => String(item || '').trim()).join('|');
}

function contains(value, needle) {
  return String(value || '').toLowerCase().includes(String(needle || '').toLowerCase());
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

function truncate(value, max) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function printUsage() {
  console.log(`Usage:
  node trade-idea-os.mjs init
  node trade-idea-os.mjs add --title "Long copper on supply squeeze" --asset COPPER --direction long --source "Podcast" --quote "..."
  node trade-idea-os.mjs import-digest /workspace/agent/trade-ideas/2026-05-06.md
  node trade-idea-os.mjs list --status triage --limit 20
  node trade-idea-os.mjs brief
  node trade-idea-os.mjs update idea-20260506-abcd1234 --status watch --follow-up 2026-05-10 --add-note "Needs live tape"

Options:
  --ledger <path>        Override ledger path
  --json                 Emit JSON
  --dry-run              Preview import-digest without writing
`);
}
