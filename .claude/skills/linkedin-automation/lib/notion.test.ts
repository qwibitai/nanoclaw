import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoist mocks before any imports ────────────────────────────────────────

const mockNotion = vi.hoisted(() => ({
  dataSources: { query: vi.fn() },
  pages: { create: vi.fn(), update: vi.fn(), retrieve: vi.fn() },
}));

vi.mock('@notionhq/client', () => ({
  // Must use a regular function (not arrow) — arrow functions can't be called with `new`
  Client: vi.fn(function () { return mockNotion; }),
}));

vi.mock('./config.js', () => ({
  config: {
    notion: {
      apiKey: 'test-api-key',
      leadsDatabaseId: 'test-db-id',
    },
  },
}));

import { upsertLead, updateLeadStatus, getLeadsByStatus, getCampaignStats, _setDataSourceId } from './notion.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makePage(
  id: string,
  profileUrl: string,
  fields: { name?: string; status?: string; title?: string; company?: string; campaign?: string } = {},
) {
  return {
    id,
    properties: {
      'Profile URL': { url: profileUrl },
      'Name': { title: fields.name ? [{ plain_text: fields.name }] : [] },
      'Status': { select: fields.status ? { name: fields.status } : null },
      'Title': { rich_text: fields.title ? [{ plain_text: fields.title }] : [] },
      'Company': { rich_text: fields.company ? [{ plain_text: fields.company }] : [] },
      'Location': { rich_text: [] },
      'Email': { email: null },
      'About': { rich_text: [] },
      'Source': { select: null },
      'Campaign': { rich_text: fields.campaign ? [{ plain_text: fields.campaign }] : [] },
      'Notes': { rich_text: [] },
      'Message Sent': { rich_text: [] },
    },
  };
}

const TEST_URL = 'https://www.linkedin.com/in/testuser';

beforeEach(() => {
  vi.clearAllMocks();
  // Pre-seed the data source ID cache to bypass the probe page mechanism
  _setDataSourceId('test-db-id');
  mockNotion.dataSources.query.mockResolvedValue({ results: [] });
  mockNotion.pages.create.mockResolvedValue({ id: 'new-page-id' });
  mockNotion.pages.update.mockResolvedValue({ id: 'upd-page-id' });
  mockNotion.pages.retrieve.mockResolvedValue({ parent: { database_id: 'test-db-id' } });
});

// ── upsertLead ─────────────────────────────────────────────────────────────

describe('upsertLead', () => {
  it('calls pages.create when lead does not exist', async () => {
    await upsertLead({ name: 'Alice', profileUrl: TEST_URL });
    expect(mockNotion.pages.create).toHaveBeenCalledOnce();
    expect(mockNotion.pages.update).not.toHaveBeenCalled();
  });

  it('calls pages.update when lead already exists', async () => {
    mockNotion.dataSources.query.mockResolvedValue({
      results: [makePage('page-123', TEST_URL)],
    });
    await upsertLead({ name: 'Alice', profileUrl: TEST_URL });
    expect(mockNotion.pages.update).toHaveBeenCalledWith(
      expect.objectContaining({ page_id: 'page-123' }),
    );
    expect(mockNotion.pages.create).not.toHaveBeenCalled();
  });

  it('trims whitespace and strips trailing slash from URL before querying', async () => {
    await upsertLead({ name: 'Alice', profileUrl: `  ${TEST_URL}/  ` });
    const queryArg = mockNotion.dataSources.query.mock.calls[0][0] as {
      filter: { url: { equals: string } };
    };
    expect(queryArg.filter.url.equals).toBe(TEST_URL);
  });

  it('always sets Last Action date property', async () => {
    await upsertLead({ name: 'Alice', profileUrl: TEST_URL });
    const createArg = mockNotion.pages.create.mock.calls[0][0] as {
      properties: Record<string, unknown>;
    };
    expect(createArg.properties['Last Action']).toMatchObject({
      date: { start: expect.any(String) },
    });
  });

  it('sets optional fields only when provided', async () => {
    await upsertLead({
      name: 'Bob',
      profileUrl: TEST_URL,
      title: 'Engineer',
      company: 'Acme',
      campaign: 'Q1',
    });
    const props = (mockNotion.pages.create.mock.calls[0][0] as {
      properties: Record<string, unknown>;
    }).properties;
    expect(props['Title']).toMatchObject({ rich_text: [{ text: { content: 'Engineer' } }] });
    expect(props['Company']).toMatchObject({ rich_text: [{ text: { content: 'Acme' } }] });
    expect(props['Campaign']).toMatchObject({ rich_text: [{ text: { content: 'Q1' } }] });
  });

  it('does NOT overwrite Name when updating an existing lead with empty name', async () => {
    // Regression: scrape-profile selector failure returned '' → overwrote existing name with 'Unknown'
    mockNotion.dataSources.query.mockResolvedValue({
      results: [makePage('page-123', TEST_URL, { name: 'Alice' })],
    });
    await upsertLead({ name: '', profileUrl: TEST_URL });
    const props = (mockNotion.pages.update.mock.calls[0][0] as {
      properties: Record<string, unknown>;
    }).properties;
    expect(props['Name']).toBeUndefined();
  });

  it('sets Name to "Unknown" on CREATE when name is empty', async () => {
    // New record must still have a Name
    await upsertLead({ name: '', profileUrl: TEST_URL });
    const props = (mockNotion.pages.create.mock.calls[0][0] as {
      properties: Record<string, unknown>;
    }).properties;
    expect(props['Name']).toMatchObject({ title: [{ text: { content: 'Unknown' } }] });
  });

  it('truncates About field to 2000 characters', async () => {
    const longAbout = 'x'.repeat(3000);
    await upsertLead({ name: 'Bob', profileUrl: TEST_URL, about: longAbout });
    const props = (mockNotion.pages.create.mock.calls[0][0] as {
      properties: Record<string, unknown>;
    }).properties;
    const aboutContent = (props['About'] as {
      rich_text: [{ text: { content: string } }];
    }).rich_text[0].text.content;
    expect(aboutContent.length).toBe(2000);
  });
});

// ── updateLeadStatus ───────────────────────────────────────────────────────

describe('updateLeadStatus', () => {
  it('calls pages.update with new Status select value on existing lead', async () => {
    mockNotion.dataSources.query.mockResolvedValue({
      results: [makePage('page-123', TEST_URL)],
    });
    await updateLeadStatus(TEST_URL, 'Connected');
    expect(mockNotion.pages.update).toHaveBeenCalledWith(
      expect.objectContaining({
        page_id: 'page-123',
        properties: expect.objectContaining({
          'Status': { select: { name: 'Connected' } },
        }),
      }),
    );
  });

  it('sets Connection Date when status is Connected', async () => {
    mockNotion.dataSources.query.mockResolvedValue({
      results: [makePage('page-123', TEST_URL)],
    });
    await updateLeadStatus(TEST_URL, 'Connected');
    const props = (mockNotion.pages.update.mock.calls[0][0] as {
      properties: Record<string, unknown>;
    }).properties;
    expect(props['Connection Date']).toMatchObject({ date: { start: expect.any(String) } });
  });

  it('does NOT set Connection Date for non-Connected statuses', async () => {
    mockNotion.dataSources.query.mockResolvedValue({
      results: [makePage('page-123', TEST_URL)],
    });
    for (const status of ['Visited', 'Requested', 'Messaged', 'Replied', 'Archived'] as const) {
      vi.clearAllMocks();
      mockNotion.dataSources.query.mockResolvedValue({
        results: [makePage('page-123', TEST_URL)],
      });
      mockNotion.pages.update.mockResolvedValue({});
      await updateLeadStatus(TEST_URL, status);
      const props = (mockNotion.pages.update.mock.calls[0][0] as {
        properties: Record<string, unknown>;
      }).properties;
      expect(props['Connection Date'], `Connection Date set for ${status}`).toBeUndefined();
    }
  });

  it('creates a minimal record (pages.create) when lead not found', async () => {
    // dataSources.query returns empty — lead does not exist
    await updateLeadStatus(TEST_URL, 'Visited');
    expect(mockNotion.pages.create).toHaveBeenCalledOnce();
    expect(mockNotion.pages.update).not.toHaveBeenCalled();
  });

  it('includes messageSent in update properties when provided in extra', async () => {
    mockNotion.dataSources.query.mockResolvedValue({
      results: [makePage('page-123', TEST_URL)],
    });
    await updateLeadStatus(TEST_URL, 'Messaged', { messageSent: 'Hi! Saw your post...' });
    const props = (mockNotion.pages.update.mock.calls[0][0] as {
      properties: Record<string, unknown>;
    }).properties;
    expect(props['Message Sent']).toMatchObject({
      rich_text: [{ text: { content: 'Hi! Saw your post...' } }],
    });
  });
});

// ── getLeadsByStatus ───────────────────────────────────────────────────────

describe('getLeadsByStatus', () => {
  it('returns empty array when Notion returns no results', async () => {
    const leads = await getLeadsByStatus('New');
    expect(leads).toEqual([]);
  });

  it('maps Notion page properties to LinkedInLead objects', async () => {
    mockNotion.dataSources.query.mockResolvedValue({
      results: [
        makePage('p1', TEST_URL, { name: 'Alice', status: 'Connected', title: 'SWE', company: 'Acme' }),
      ],
    });
    const leads = await getLeadsByStatus('Connected');
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({
      name: 'Alice',
      profileUrl: TEST_URL,
      title: 'SWE',
      company: 'Acme',
      status: 'Connected',
    });
  });

  it('passes the status filter to dataSources.query', async () => {
    await getLeadsByStatus('Requested');
    const arg = mockNotion.dataSources.query.mock.calls[0][0] as {
      filter: { property: string; select: { equals: string } };
    };
    expect(arg.filter).toMatchObject({
      property: 'Status',
      select: { equals: 'Requested' },
    });
  });

  it('adds campaign as AND filter when campaign is provided', async () => {
    await getLeadsByStatus('New', 'Q1 Campaign');
    const arg = mockNotion.dataSources.query.mock.calls[0][0] as {
      filter: { and: unknown[] };
    };
    expect(arg.filter.and).toHaveLength(2);
    expect(arg.filter.and[1]).toMatchObject({
      property: 'Campaign',
      rich_text: { contains: 'Q1 Campaign' },
    });
  });

  it('handles null select property gracefully — returns empty string, no crash', async () => {
    mockNotion.dataSources.query.mockResolvedValue({
      results: [makePage('p1', TEST_URL)],  // Status select is null
    });
    const leads = await getLeadsByStatus('New');
    expect(leads[0].status).toBe('');
  });

  it('handles empty rich_text array gracefully — returns empty string, no crash', async () => {
    const page = makePage('p1', TEST_URL, { name: 'Alice' });
    // Title has empty rich_text (already the case from makePage with no title)
    mockNotion.dataSources.query.mockResolvedValue({ results: [page] });
    const leads = await getLeadsByStatus('New');
    expect(leads[0].title).toBe('');
  });
});

// ── getCampaignStats ───────────────────────────────────────────────────────

describe('getCampaignStats', () => {
  it('returns an object with all 7 LeadStatus keys', async () => {
    const stats = await getCampaignStats();
    expect(Object.keys(stats).sort()).toEqual(
      ['Archived', 'Connected', 'Messaged', 'New', 'Replied', 'Requested', 'Visited'],
    );
  });

  it('returns zero for every status when Notion has no leads', async () => {
    const stats = await getCampaignStats();
    for (const count of Object.values(stats)) {
      expect(count).toBe(0);
    }
  });

  it('counts leads correctly per status', async () => {
    mockNotion.dataSources.query.mockImplementation(
      ({ filter }: { filter: { select?: { equals: string }; and?: [{ select: { equals: string } }] } }) => {
        const status = filter.select?.equals ?? filter.and?.[0]?.select?.equals;
        const count = status === 'New' ? 4 : status === 'Connected' ? 2 : 0;
        return Promise.resolve({
          results: Array.from({ length: count }, (_, i) =>
            makePage(`p${i}`, `${TEST_URL}-${i}`, { status }),
          ),
        });
      },
    );
    const stats = await getCampaignStats();
    expect(stats.New).toBe(4);
    expect(stats.Connected).toBe(2);
    expect(stats.Visited).toBe(0);
    expect(stats.Replied).toBe(0);
  });
});

// ── Notion API error handling ──────────────────────────────────────────────

describe('Notion API error handling', () => {
  it('propagates 403/unauthorized error from dataSources.query — not swallowed', async () => {
    const authErr = Object.assign(new Error('Unauthorized'), { code: 'unauthorized', status: 403 });
    mockNotion.dataSources.query.mockRejectedValue(authErr);
    await expect(upsertLead({ name: 'Test', profileUrl: TEST_URL })).rejects.toThrow('Unauthorized');
  });

  it('propagates error from pages.create — not swallowed', async () => {
    mockNotion.pages.create.mockRejectedValue(new Error('Database not found'));
    await expect(upsertLead({ name: 'Test', profileUrl: TEST_URL })).rejects.toThrow(
      'Database not found',
    );
  });

  it('propagates error from pages.update — not swallowed', async () => {
    mockNotion.dataSources.query.mockResolvedValue({
      results: [makePage('page-123', TEST_URL)],
    });
    mockNotion.pages.update.mockRejectedValue(new Error('Page archived'));
    await expect(upsertLead({ name: 'Test', profileUrl: TEST_URL })).rejects.toThrow('Page archived');
  });

  it('getLeadsByStatus returns [] when dataSources.query returns empty results', async () => {
    mockNotion.dataSources.query.mockResolvedValue({ results: [] });
    const leads = await getLeadsByStatus('New');
    expect(leads).toEqual([]);
  });
});

// ── getDataSourceId probe mechanism ───────────────────────────────────────

describe('getDataSourceId probe mechanism', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('trashes the probe page even when pages.retrieve throws', async () => {
    // Regression: ISSUE-001 — probe page leaks when pages.retrieve fails
    // Found by /qa on 2026-03-23
    const freshClient = {
      dataSources: { query: vi.fn().mockResolvedValue({ results: [] }) },
      pages: {
        create:   vi.fn().mockResolvedValue({ id: 'probe-123' }),
        update:   vi.fn().mockResolvedValue({}),
        retrieve: vi.fn().mockRejectedValue(new Error('retrieve timed out')),
      },
    };
    vi.doMock('@notionhq/client', () => ({ Client: vi.fn(function () { return freshClient; }) }));
    vi.doMock('./config.js', () => ({
      config: { notion: { apiKey: 'test-key', leadsDatabaseId: 'test-db-id' } },
    }));

    const { upsertLead: freshUpsert } = await import('./notion.js');

    await expect(freshUpsert({ name: 'Test', profileUrl: TEST_URL })).rejects.toThrow('retrieve timed out');

    // Probe page must always be trashed — even when retrieve fails
    expect(freshClient.pages.update).toHaveBeenCalledWith(
      expect.objectContaining({ page_id: 'probe-123', in_trash: true }),
    );
  });

  it('caches the data_source_id after the probe succeeds — probe runs once only', async () => {
    const freshClient = {
      dataSources: { query: vi.fn().mockResolvedValue({ results: [] }) },
      pages: {
        create:   vi.fn().mockResolvedValue({ id: 'probe-456' }),
        update:   vi.fn().mockResolvedValue({}),
        retrieve: vi.fn().mockResolvedValue({ parent: { data_source_id: 'ds-999' } }),
      },
    };
    vi.doMock('@notionhq/client', () => ({ Client: vi.fn(function () { return freshClient; }) }));
    vi.doMock('./config.js', () => ({
      config: { notion: { apiKey: 'test-key', leadsDatabaseId: 'test-db-id' } },
    }));

    const { upsertLead: freshUpsert } = await import('./notion.js');

    // Two calls — only the first should trigger the probe
    await freshUpsert({ name: 'Test', profileUrl: TEST_URL });
    await freshUpsert({ name: 'Test2', profileUrl: TEST_URL + '2' });

    // pages.retrieve is the probe mechanism — must be called exactly once
    expect(freshClient.pages.retrieve).toHaveBeenCalledTimes(1);
  });
});

// ── Configuration errors (require fresh module instances) ─────────────────

describe('configuration errors', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('throws "NOTION_API_KEY is not set" when apiKey is empty', async () => {
    vi.doMock('@notionhq/client', () => ({ Client: vi.fn(function () { return {}; }) }));
    vi.doMock('./config.js', () => ({
      config: { notion: { apiKey: '', leadsDatabaseId: 'some-db-id' } },
    }));
    const { upsertLead: freshUpsert } = await import('./notion.js');
    await expect(freshUpsert({ name: 'Test', profileUrl: TEST_URL })).rejects.toThrow(
      'NOTION_API_KEY',
    );
  });

  it('throws "NOTION_LEADS_DB_ID is not set" when leadsDatabaseId is empty', async () => {
    const freshClient = {
      dataSources: { query: vi.fn().mockResolvedValue({ results: [] }) },
      pages: { create: vi.fn() },
    };
    vi.doMock('@notionhq/client', () => ({ Client: vi.fn(function () { return freshClient; }) }));
    vi.doMock('./config.js', () => ({
      config: { notion: { apiKey: 'valid-key', leadsDatabaseId: '' } },
    }));
    const { upsertLead: freshUpsert } = await import('./notion.js');
    await expect(freshUpsert({ name: 'Test', profileUrl: TEST_URL })).rejects.toThrow(
      'NOTION_LEADS_DB_ID',
    );
  });
});
