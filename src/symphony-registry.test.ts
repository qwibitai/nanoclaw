import { describe, expect, it } from 'vitest';

import { fetchProjectRegistryFromNotion } from './symphony-registry.js';

describe('fetchProjectRegistryFromNotion', () => {
  it('parses a strict Notion project registry page set', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              id: 'page-1',
              url: 'https://www.notion.so/workspace/nanoclaw-root',
              properties: {
                Name: {
                  type: 'title',
                  title: [{ plain_text: 'NanoClaw' }],
                },
                'Project Key': {
                  type: 'rich_text',
                  rich_text: [{ plain_text: 'nanoclaw' }],
                },
                'Linear Project': {
                  type: 'rich_text',
                  rich_text: [{ plain_text: 'nanoclaw' }],
                },
                'Notion Root': {
                  type: 'url',
                  url: 'https://www.notion.so/workspace/nanoclaw-root',
                },
                'GitHub Repo': {
                  type: 'rich_text',
                  rich_text: [{ plain_text: 'ingpoc/nanoclaw' }],
                },
                'Symphony Enabled': {
                  type: 'checkbox',
                  checkbox: true,
                },
                'Allowed Backends': {
                  type: 'multi_select',
                  multi_select: [{ name: 'codex' }, { name: 'claude-code' }],
                },
                'Default Backend': {
                  type: 'select',
                  select: { name: 'codex' },
                },
                'Work Classes Supported': {
                  type: 'multi_select',
                  multi_select: [{ name: 'nanoclaw-core' }],
                },
                'Secret Scope': {
                  type: 'rich_text',
                  rich_text: [{ plain_text: 'nanoclaw' }],
                },
                'Workspace Root': {
                  type: 'rich_text',
                  rich_text: [{ plain_text: '/tmp/nanoclaw-symphony' }],
                },
                'Ready Policy': {
                  type: 'rich_text',
                  rich_text: [{ plain_text: 'andy-developer-ready-v1' }],
                },
              },
            },
          ],
          has_more: false,
          next_cursor: null,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ) as Response;

    process.env.NOTION_TOKEN = 'test-token';

    await expect(
      fetchProjectRegistryFromNotion('registry-db'),
    ).resolves.toMatchObject({
      schemaVersion: 1,
      projects: [
        {
          projectKey: 'nanoclaw',
          notionRoot: 'https://www.notion.so/workspace/nanoclaw-root',
          allowedBackends: ['codex', 'claude-code'],
        },
      ],
    });

    global.fetch = originalFetch;
  });

  it('fails loud when a required registry property is missing', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              id: 'page-2',
              url: 'https://www.notion.so/workspace/project-root',
              properties: {
                Name: {
                  type: 'title',
                  title: [{ plain_text: 'Broken Project' }],
                },
              },
            },
          ],
          has_more: false,
          next_cursor: null,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ) as Response;

    process.env.NOTION_TOKEN = 'test-token';

    await expect(
      fetchProjectRegistryFromNotion('registry-db'),
    ).rejects.toThrow(/missing property "Project Key"/i);

    global.fetch = originalFetch;
  });
});
