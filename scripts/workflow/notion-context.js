#!/usr/bin/env node

const NOTION_API_URL = process.env.NOTION_API_URL || 'https://api.notion.com/v1';
const NOTION_VERSION = process.env.NOTION_VERSION || '2022-06-28';

function parseArgs(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      options.set(token.slice(2), 'true');
      continue;
    }
    options.set(token.slice(2), next);
    index += 1;
  }
  return options;
}

function requireToken() {
  const token = process.env.NOTION_TOKEN || process.env.NOTION_API_KEY || '';
  if (!token) {
    throw new Error('Missing NOTION_TOKEN or NOTION_API_KEY.');
  }
  return token;
}

async function notionRequest(method, route, body) {
  const token = requireToken();
  const response = await fetch(`${NOTION_API_URL}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Notion-Version': NOTION_VERSION,
      'User-Agent': 'nanoclaw-notion-context',
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

function richText(content, link) {
  return [
    {
      type: 'text',
      text: {
        content,
        link: link ? { url: link } : null,
      },
    },
  ];
}

function buildSummaryBlocks(options) {
  const lines = [];
  const branch = options.get('branch') || '';
  const issue = options.get('issue') || '';
  const state = options.get('state') || '';
  const done = options.get('done') || '';
  const next = options.get('next') || '';
  const blocker = options.get('blocker') || '';
  const linearUrl = options.get('linear-url') || '';
  const githubUrl = options.get('github-url') || '';

  if (branch) lines.push(`Branch: ${branch}`);
  if (issue) lines.push(`Issue: ${issue}`);
  if (state) lines.push(`State: ${state}`);
  if (done) lines.push(`Done: ${done}`);
  if (next) lines.push(`Next: ${next}`);
  if (blocker) lines.push(`Blocker: ${blocker}`);

  const blocks = [
    {
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: richText(lines.join('\n') || 'Session summary'),
      },
    },
  ];

  if (linearUrl) {
    blocks.push({
      object: 'block',
      type: 'bookmark',
      bookmark: { url: linearUrl },
    });
  }
  if (githubUrl) {
    blocks.push({
      object: 'block',
      type: 'bookmark',
      bookmark: { url: githubUrl },
    });
  }

  return blocks;
}

async function fetchMarkdown(options) {
  const pageId = options.get('page');
  if (!pageId) {
    throw new Error('fetch-markdown requires --page <page-id>');
  }

  const payload = await notionRequest('GET', `/pages/${pageId}/markdown`);
  process.stdout.write(
    `${JSON.stringify({ pageId, markdown: payload.markdown || '' }, null, 2)}\n`,
  );
}

async function publishSessionSummary(options) {
  const databaseId = options.get('database') || process.env.NOTION_SESSION_SUMMARY_DATABASE_ID || '';
  const title = options.get('title') || 'Session summary';
  if (!databaseId) {
    throw new Error(
      'publish-session-summary requires --database <database-id> or NOTION_SESSION_SUMMARY_DATABASE_ID.',
    );
  }

  const payload = await notionRequest('POST', '/pages', {
    parent: { database_id: databaseId },
    properties: {
      Name: {
        title: richText(title),
      },
    },
    children: buildSummaryBlocks(options),
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        pageId: payload.id,
        url: payload.url,
        title,
      },
      null,
      2,
    )}\n`,
  );
}

async function main() {
  const command = process.argv[2];
  if (!command) {
    throw new Error('Usage: node scripts/workflow/notion-context.js <fetch-markdown|publish-session-summary> [options]');
  }

  const options = parseArgs(process.argv.slice(3));
  if (command === 'fetch-markdown') {
    await fetchMarkdown(options);
    return;
  }

  if (command === 'publish-session-summary') {
    await publishSessionSummary(options);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
