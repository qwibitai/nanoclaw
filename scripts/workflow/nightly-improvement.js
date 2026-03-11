#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const DEFAULT_STATE_PATH = path.join(
  ROOT_DIR,
  '.nanoclaw',
  'nightly-improvement',
  'state.json',
);
const MAX_TRACKED_EVALUATIONS = 100;
const MAX_UPSTREAM_COMMITS = 12;
const MAX_TOOL_CANDIDATES = 3;
const UPSTREAM_REMOTE = process.env.NANOCLAW_NIGHTLY_UPSTREAM_REMOTE || 'upstream';
const UPSTREAM_BRANCH = process.env.NANOCLAW_NIGHTLY_UPSTREAM_BRANCH || 'main';
const NOTION_API_URL = process.env.NOTION_API_URL || 'https://api.notion.com/v1';
const NOTION_VERSION = process.env.NOTION_VERSION || '2022-06-28';
const NOTION_NIGHTLY_DATABASE_ID =
  process.env.NOTION_NIGHTLY_DATABASE_ID ||
  process.env.NOTION_SHARED_CONTEXT_DATABASE_ID ||
  '';

const CONTEXT_KINDS = {
  upstream: {
    title: '[Nightly] NanoClaw Upstream Sync',
    marker: '<!-- nightly-improvement:upstream -->',
  },
  tooling: {
    title: '[Nightly] SDK and Tooling Opportunities',
    marker: '<!-- nightly-improvement:tooling -->',
  },
};

const TOOL_SOURCES = [
  {
    key: 'claude_code',
    displayName: 'Claude Code',
    owner: 'anthropics',
    repo: 'claude-code',
  },
  {
    key: 'claude_agent_sdk',
    displayName: 'Claude Agent SDK',
    owner: 'anthropics',
    repo: 'claude-agent-sdk-typescript',
  },
  {
    key: 'opencode',
    displayName: 'OpenCode',
    owner: 'sst',
    repo: 'opencode',
  },
];

function usage() {
  console.log(`Usage: node scripts/workflow/nightly-improvement.js <command> [options]

Commands:
  scan [--output <path>] [--force] [--force-source <key>] [--force-key <key>]
  record --scan-file <path>
  upsert-context --kind <upstream|tooling> (--body-file <path> | --body-stdin) [--title <title>]
  append-decision --kind <upstream|tooling> --decision <pilot|defer|reject> --summary <text>
    [--agent-label <label>] [--to <agent>] [--status <status>] [--next <text>]
`);
}

function parseArgs(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      const existing = options.get(key) || [];
      existing.push('true');
      options.set(key, existing);
      continue;
    }
    const existing = options.get(key) || [];
    existing.push(next);
    options.set(key, existing);
    index += 1;
  }
  return options;
}

function optionValue(options, key) {
  return (options.get(key) || [])[0] || null;
}

function optionValues(options, key) {
  return options.get(key) || [];
}

function runGit(args) {
  return execFileSync('git', args, {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function githubRest(url) {
  const token =
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    '';

  const response = await fetch(url, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      Accept: 'application/vnd.github+json',
      'User-Agent': 'nanoclaw-nightly-improvement',
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub REST request failed: ${response.status} ${response.statusText}\n${text}`);
  }

  return response.json();
}

function defaultState() {
  return {
    schema_version: 2,
    last_run_at: null,
    last_upstream_sha: null,
    tool_versions: {},
    context_refs: {},
    evaluated_keys: {},
  };
}

function loadState(statePath = DEFAULT_STATE_PATH) {
  if (!fs.existsSync(statePath)) {
    return defaultState();
  }
  const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const allowedTopLevelKeys = new Set([
    'schema_version',
    'last_run_at',
    'last_upstream_sha',
    'tool_versions',
    'context_refs',
    'evaluated_keys',
  ]);
  const unexpectedKeys = Object.keys(parsed).filter((key) => !allowedTopLevelKeys.has(key));
  if (unexpectedKeys.length > 0) {
    throw new Error(
      `Unsupported nightly state schema in ${statePath}. Remove unexpected keys: ${unexpectedKeys.join(', ')}.`,
    );
  }
  for (const [evaluationKey, evaluation] of Object.entries(parsed.evaluated_keys || {})) {
    if (evaluation && typeof evaluation === 'object' && !('pageId' in evaluation)) {
      throw new Error(
        `Unsupported nightly evaluation record for ${evaluationKey} in ${statePath}. Each record must store pageId.`,
      );
    }
  }
  return {
    ...defaultState(),
    ...parsed,
    tool_versions: parsed.tool_versions || {},
    context_refs: parsed.context_refs || {},
    evaluated_keys: parsed.evaluated_keys || {},
  };
}

function saveState(state, statePath = DEFAULT_STATE_PATH) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function nowIso() {
  return new Date().toISOString();
}

export function buildEvaluationKey(sourceKey, cursor) {
  if (sourceKey === 'upstream') {
    return `upstream:${cursor}`;
  }
  return `tool:${sourceKey}@${cursor}`;
}

export function shouldProcessEvaluation({
  evaluatedKeys,
  evaluationKey,
  sourceKey,
  force = false,
  forceSources = [],
  forceKeys = [],
}) {
  if (force) return true;
  if (forceKeys.includes(evaluationKey)) return true;
  if (forceSources.includes(sourceKey)) return true;
  return !evaluatedKeys[evaluationKey];
}

export function pruneEvaluatedKeys(evaluatedKeys) {
  const entries = Object.entries(evaluatedKeys || {}).sort((left, right) =>
    String(right[1]?.evaluatedAt || '').localeCompare(String(left[1]?.evaluatedAt || '')),
  );
  return Object.fromEntries(entries.slice(0, MAX_TRACKED_EVALUATIONS));
}

export function applyNightlyRecord(
  previousState,
  scan,
  refs = {},
  recordedAt = nowIso(),
) {
  const nextState = {
    ...defaultState(),
    ...previousState,
    last_run_at: recordedAt,
    last_upstream_sha: scan.upstream?.toSha || previousState.last_upstream_sha || null,
    tool_versions: {
      ...(previousState.tool_versions || {}),
    },
    context_refs: {
      ...(previousState.context_refs || {}),
    },
    evaluated_keys: {
      ...(previousState.evaluated_keys || {}),
    },
  };

  const deferredToolKeys = new Set(
    (scan.tooling?.deferredCandidates || []).map((candidate) => candidate.key),
  );
  for (const [toolKey, currentVersion] of Object.entries(
    scan.tooling?.currentVersions || {},
  )) {
    if (deferredToolKeys.has(toolKey)) continue;
    nextState.tool_versions[toolKey] = currentVersion;
  }

  if (refs.upstreamPageId || refs.upstreamPageUrl) {
    nextState.context_refs.upstream = {
      ...(nextState.context_refs.upstream || {}),
      pageId: refs.upstreamPageId || nextState.context_refs.upstream?.pageId || null,
      url: refs.upstreamPageUrl || nextState.context_refs.upstream?.url || null,
      kind: 'upstream',
      updatedAt: recordedAt,
    };
  }
  if (refs.toolingPageId || refs.toolingPageUrl) {
    nextState.context_refs.tooling = {
      ...(nextState.context_refs.tooling || {}),
      pageId: refs.toolingPageId || nextState.context_refs.tooling?.pageId || null,
      url: refs.toolingPageUrl || nextState.context_refs.tooling?.url || null,
      kind: 'tooling',
      updatedAt: recordedAt,
    };
  }

  if (scan.upstream?.pending && scan.upstream.evaluationKey) {
    nextState.evaluated_keys[scan.upstream.evaluationKey] = {
      kind: 'upstream',
      cursor: scan.upstream.toSha,
      pageId: refs.upstreamPageId || previousState.context_refs?.upstream?.pageId || null,
      evaluatedAt: recordedAt,
    };
  }

  for (const candidate of scan.tooling?.candidates || []) {
    if (!candidate.pending || !candidate.evaluationKey) continue;
    nextState.evaluated_keys[candidate.evaluationKey] = {
      kind: 'tooling',
      sourceKey: candidate.key,
      cursor: candidate.currentVersion,
      pageId: refs.toolingPageId || previousState.context_refs?.tooling?.pageId || null,
      evaluatedAt: recordedAt,
    };
  }

  nextState.evaluated_keys = pruneEvaluatedKeys(nextState.evaluated_keys);
  return nextState;
}

function parseCommitLines(rawValue) {
  return rawValue
    .split('\x1e')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, subject, body] = line.split('\x1f');
      return { sha, subject, body: body?.trim() || '' };
    });
}

function fetchUpstreamSummary(previousSha) {
  const remoteRef = `${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}`;
  runGit(['fetch', '--prune', UPSTREAM_REMOTE, UPSTREAM_BRANCH]);
  const headSha = runGit(['rev-parse', '--verify', `${remoteRef}^{commit}`]);
  const changed = previousSha !== headSha;
  const commitRange = previousSha ? `${previousSha}..${headSha}` : headSha;
  let commitCount = 0;
  let commits = [];

  if (changed) {
    const rawCommits = runGit([
      'log',
      '--max-count',
      String(MAX_UPSTREAM_COMMITS),
      '--format=%H%x1f%s%x1f%b%x1e',
      commitRange,
    ]);
    commits = parseCommitLines(rawCommits).map((commit) => ({
      ...commit,
      shortSha: commit.sha.slice(0, 7),
      url: `https://github.com/qwibitai/nanoclaw/commit/${commit.sha}`,
      evaluationKey: buildEvaluationKey('upstream', headSha),
    }));
    commitCount = previousSha
      ? Number.parseInt(runGit(['rev-list', '--count', commitRange]), 10)
      : commits.length;
  }

  return {
    bootstrap: !previousSha,
    fromSha: previousSha,
    toSha: headSha,
    changed,
    commitCount,
    commits,
  };
}

async function fetchLatestToolRelease(tool) {
  const releaseBase = `https://api.github.com/repos/${tool.owner}/${tool.repo}`;
  try {
    const release = await githubRest(`${releaseBase}/releases/latest`);
    return {
      version: release.tag_name || release.name || 'unknown',
      url: release.html_url || `https://github.com/${tool.owner}/${tool.repo}/releases`,
      bodyExcerpt: String(release.body || '').slice(0, 5000),
      publishedAt: release.published_at || null,
      sourceType: 'release',
    };
  } catch {
    const tags = await githubRest(`${releaseBase}/tags?per_page=1`);
    const tag = Array.isArray(tags) ? tags[0] : null;
    if (!tag) {
      throw new Error(`Unable to resolve latest version for ${tool.displayName}`);
    }
    return {
      version: tag.name,
      url: `https://github.com/${tool.owner}/${tool.repo}/tree/${tag.name}`,
      bodyExcerpt: '',
      publishedAt: null,
      sourceType: 'tag',
    };
  }
}

function notionToken() {
  const token = process.env.NOTION_TOKEN || process.env.NOTION_API_KEY || '';
  if (!token) {
    throw new Error('Missing NOTION_TOKEN or NOTION_API_KEY for nightly context sync.');
  }
  return token;
}

async function notionRequest(method, route, body) {
  const response = await fetch(`${NOTION_API_URL}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${notionToken()}`,
      'Content-Type': 'application/json',
      'Notion-Version': NOTION_VERSION,
      'User-Agent': 'nanoclaw-nightly-improvement',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = await response.json();
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

function notionDatabaseId() {
  if (!NOTION_NIGHTLY_DATABASE_ID) {
    throw new Error(
      'Missing NOTION_NIGHTLY_DATABASE_ID or NOTION_SHARED_CONTEXT_DATABASE_ID for nightly context sync.',
    );
  }
  return NOTION_NIGHTLY_DATABASE_ID;
}

function richText(content) {
  return [{ type: 'text', text: { content } }];
}

function chunkText(text, maxLength = 1800) {
  const input = String(text || '');
  if (!input) return [];
  const chunks = [];
  let cursor = input;
  while (cursor.length > maxLength) {
    chunks.push(cursor.slice(0, maxLength));
    cursor = cursor.slice(maxLength);
  }
  if (cursor) chunks.push(cursor);
  return chunks;
}

function markdownToBlocks(markdown, heading) {
  const lines = String(markdown || '')
    .split('\n')
    .map((line) => line.trimEnd());

  const blocks = [];
  if (heading) {
    blocks.push({
      object: 'block',
      type: 'heading_2',
      heading_2: { rich_text: richText(heading) },
    });
  }

  for (const line of lines) {
    if (!line.trim()) continue;
    const type = line.startsWith('- ') ? 'bulleted_list_item' : 'paragraph';
    const content = line.startsWith('- ') ? line.slice(2) : line;
    for (const chunk of chunkText(content)) {
      blocks.push({
        object: 'block',
        type,
        [type]: {
          rich_text: richText(chunk),
        },
      });
    }
  }

  if (blocks.length === 0) {
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: richText('No update content provided.') },
    });
  }

  return blocks;
}

async function findContextPageByTitle(title) {
  const payload = await notionRequest('POST', `/databases/${notionDatabaseId()}/query`, {
    filter: {
      property: 'Name',
      title: {
        equals: title,
      },
    },
    page_size: 1,
  });

  return payload.results?.[0] || null;
}

async function appendPageBlocks(pageId, blocks) {
  await notionRequest('PATCH', `/blocks/${pageId}/children`, {
    children: blocks,
  });
}

function contextSummary(context) {
  if (!context) return null;
  return {
    pageId: context.pageId || null,
    title: context.title || null,
    url: context.url || null,
    updatedAt: context.updatedAt || null,
    pendingFor: context.pendingFor || null,
    lastDecisionBy: context.lastDecisionBy || null,
    lastDecisionAt: context.lastDecisionAt || null,
    lastDecisionSummary: context.lastDecisionSummary || null,
  };
}

async function buildScan(options) {
  const statePath = optionValue(options, 'state-path') || DEFAULT_STATE_PATH;
  const state = loadState(statePath);
  const force = options.has('force');
  const forceSources = optionValues(options, 'force-source');
  const forceKeys = optionValues(options, 'force-key');

  const upstreamSummary = fetchUpstreamSummary(state.last_upstream_sha);
  const upstreamEvaluationKey = buildEvaluationKey('upstream', upstreamSummary.toSha);
  const upstreamPending =
    upstreamSummary.changed &&
    shouldProcessEvaluation({
      evaluatedKeys: state.evaluated_keys,
      evaluationKey: upstreamEvaluationKey,
      sourceKey: 'upstream',
      force,
      forceSources,
      forceKeys,
    });

  const toolingCandidates = [];
  for (const tool of TOOL_SOURCES) {
    const latest = await fetchLatestToolRelease(tool);
    const previousVersion = state.tool_versions?.[tool.key] || null;
    const changed = previousVersion !== latest.version;
    const evaluationKey = buildEvaluationKey(tool.key, latest.version);
    const pending =
      changed &&
      shouldProcessEvaluation({
        evaluatedKeys: state.evaluated_keys,
        evaluationKey,
        sourceKey: tool.key,
        force,
        forceSources,
        forceKeys,
      });

    toolingCandidates.push({
      ...tool,
      previousVersion,
      currentVersion: latest.version,
      changed,
      pending,
      evaluationKey,
      url: latest.url,
      publishedAt: latest.publishedAt,
      sourceType: latest.sourceType,
      bodyExcerpt: latest.bodyExcerpt,
    });
  }

  const pendingTooling = toolingCandidates.filter((candidate) => candidate.pending);
  const limitedTooling = pendingTooling.slice(0, MAX_TOOL_CANDIDATES);
  const deferredTooling = pendingTooling.slice(MAX_TOOL_CANDIDATES).map((candidate) => ({
    key: candidate.key,
    currentVersion: candidate.currentVersion,
  }));

  return {
    action: upstreamPending || limitedTooling.length > 0 ? 'evaluate' : 'noop',
    generatedAt: nowIso(),
    statePath,
    limits: {
      maxUpstreamCommits: MAX_UPSTREAM_COMMITS,
      maxToolCandidates: MAX_TOOL_CANDIDATES,
    },
    upstream: {
      ...upstreamSummary,
      pending: upstreamPending,
      evaluationKey: upstreamEvaluationKey,
      context: contextSummary(state.context_refs?.upstream || null),
    },
    tooling: {
      context: contextSummary(state.context_refs?.tooling || null),
      candidates: limitedTooling,
      deferredCandidates: deferredTooling,
      currentVersions: Object.fromEntries(
        toolingCandidates.map((candidate) => [candidate.key, candidate.currentVersion]),
      ),
    },
  };
}

async function upsertContext(kind, body, titleOverride = null, statePath = DEFAULT_STATE_PATH) {
  const config = CONTEXT_KINDS[kind];
  if (!config) {
    throw new Error(`Unsupported context kind: ${kind}`);
  }

  const title = titleOverride || config.title;
  const state = loadState(statePath);
  let existing = null;
  const knownPageId = state.context_refs?.[kind]?.pageId;

  if (knownPageId) {
    try {
      existing = await notionRequest('GET', `/pages/${knownPageId}`);
    } catch {
      existing = null;
    }
  }

  if (!existing) {
    existing = await findContextPageByTitle(title);
  }

  const heading = `Nightly Update • ${nowIso()}`;
  const children = markdownToBlocks(body, heading);
  const markerBlock = {
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: richText(config.marker) },
  };

  let page;
  let action;

  if (existing?.id) {
    await appendPageBlocks(existing.id, [markerBlock, ...children]);
    page = await notionRequest('GET', `/pages/${existing.id}`);
    action = 'updated';
  } else {
    page = await notionRequest('POST', '/pages', {
      parent: { database_id: notionDatabaseId() },
      properties: {
        Name: {
          title: richText(title),
        },
      },
      children: [markerBlock, ...children],
    });
    action = 'created';
  }

  const nextState = loadState(statePath);
  nextState.context_refs[kind] = {
    ...(nextState.context_refs[kind] || {}),
    kind,
    pageId: page.id,
    title,
    url: page.url,
    updatedAt: nowIso(),
  };
  saveState(nextState, statePath);

  return {
    kind,
    action,
    pageId: page.id,
    url: page.url,
    title,
  };
}

async function appendDecision(kind, decision, summary, extras = {}, statePath = DEFAULT_STATE_PATH) {
  const state = loadState(statePath);
  const context = state.context_refs?.[kind];
  if (!context?.pageId) {
    throw new Error(`Unable to resolve nightly context page for kind: ${kind}`);
  }

  const lines = [
    CONTEXT_KINDS[kind]?.marker || '',
    `Agent Label: ${extras.agentLabel || 'Claude Code'}`,
    `Decision: ${decision}`,
    `Summary: ${summary}`,
  ].filter(Boolean);

  if (extras.to) lines.push(`To: ${extras.to}`);
  if (extras.status) lines.push(`Status: ${extras.status}`);
  if (extras.next) lines.push(`Next: ${extras.next}`);

  await appendPageBlocks(
    context.pageId,
    markdownToBlocks(lines.join('\n'), `Decision Update • ${nowIso()}`),
  );

  const target = String(extras.to || '').trim().toLowerCase();
  const actor = String(extras.agentLabel || '').trim().toLowerCase();
  const pendingFor = target && !actor.includes(target) ? target : null;

  const nextState = loadState(statePath);
  nextState.context_refs[kind] = {
    ...(nextState.context_refs[kind] || {}),
    kind,
    pageId: context.pageId,
    title: context.title,
    url: context.url,
    updatedAt: nowIso(),
    pendingFor,
    lastDecisionBy: extras.agentLabel || 'Claude Code',
    lastDecisionAt: nowIso(),
    lastDecisionSummary: summary,
  };
  saveState(nextState, statePath);

  return {
    kind,
    pageId: context.pageId,
    url: context.url,
    pendingFor,
    decision,
    summary,
  };
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeOutput(value, outputPath = null) {
  const rendered = `${JSON.stringify(value, null, 2)}\n`;
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, rendered);
    return;
  }
  process.stdout.write(rendered);
}

async function main() {
  const command = process.argv[2];
  const options = parseArgs(process.argv.slice(3));

  switch (command) {
    case 'scan': {
      const scan = await buildScan(options);
      writeOutput(scan, optionValue(options, 'output'));
      return;
    }

    case 'record': {
      const scanFile = optionValue(options, 'scan-file');
      if (!scanFile) {
        throw new Error('record requires --scan-file');
      }
      const statePath = optionValue(options, 'state-path') || DEFAULT_STATE_PATH;
      const state = loadState(statePath);
      const scan = readJsonFile(scanFile);
      const nextState = applyNightlyRecord(state, scan, {
        upstreamPageId: optionValue(options, 'upstream-page-id'),
        upstreamPageUrl: optionValue(options, 'upstream-page-url'),
        toolingPageId: optionValue(options, 'tooling-page-id'),
        toolingPageUrl: optionValue(options, 'tooling-page-url'),
      });
      saveState(nextState, statePath);
      writeOutput(nextState);
      return;
    }

    case 'upsert-context': {
      const kind = optionValue(options, 'kind');
      const bodyFile = optionValue(options, 'body-file');
      const useBodyStdin = options.has('body-stdin');
      if (!kind || (!bodyFile && !useBodyStdin)) {
        throw new Error(
          'upsert-context requires --kind and either --body-file or --body-stdin',
        );
      }
      const result = await upsertContext(
        kind,
        useBodyStdin ? fs.readFileSync(0, 'utf8') : fs.readFileSync(bodyFile, 'utf8'),
        optionValue(options, 'title'),
        optionValue(options, 'state-path') || DEFAULT_STATE_PATH,
      );
      writeOutput(result);
      return;
    }

    case 'append-decision': {
      const kind = optionValue(options, 'kind');
      const decision = optionValue(options, 'decision');
      const summary = optionValue(options, 'summary');
      const agentLabel = optionValue(options, 'agent-label');
      const to = optionValue(options, 'to');
      const status = optionValue(options, 'status');
      const next = optionValue(options, 'next');
      if (!kind || !decision || !summary) {
        throw new Error(
          'append-decision requires --kind, --decision, and --summary',
        );
      }
      const result = await appendDecision(kind, decision, summary, {
        agentLabel,
        to,
        status,
        next,
      }, optionValue(options, 'state-path') || DEFAULT_STATE_PATH);
      writeOutput(result);
      return;
    }

    default:
      usage();
      if (command) {
        process.exitCode = 1;
      }
  }
}

const isMainModule =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
