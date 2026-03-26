/**
 * LinkedIn Automation — Notion CRM Integration
 *
 * Manages the LinkedIn Leads database in Notion.
 * All leads, statuses, and outreach history are stored here.
 */

import { Client } from '@notionhq/client';
import { config } from './config.js';

export type LeadStatus =
  | 'New'
  | 'Visited'
  | 'Requested'
  | 'Connected'
  | 'Messaged'
  | 'Replied'
  | 'Archived';

export interface LinkedInLead {
  name:          string;
  profileUrl:    string;
  title?:        string;
  company?:      string;
  location?:     string;
  email?:        string;
  about?:        string;
  source?:       string;
  status?:       LeadStatus;
  campaign?:     string;
  notes?:        string;
  messageSent?:  string;
}

let _client: Client | null = null;
let _dataSourceId: string | null = null;

function getClient(): Client {
  if (!_client) {
    if (!config.notion.apiKey) throw new Error('NOTION_API_KEY is not set in .env');
    _client = new Client({ auth: config.notion.apiKey });
  }
  return _client;
}

function getDbId(): string {
  if (!config.notion.leadsDatabaseId) throw new Error('NOTION_LEADS_DB_ID is not set in .env');
  return config.notion.leadsDatabaseId;
}

/**
 * Notion uses two different IDs for the same database:
 *   - database_id  → used for pages.create (write operations)
 *   - data_source_id → required for dataSources.query (read operations)
 *
 * We discover the data_source_id once by creating a probe page, reading its
 * parent.data_source_id, then immediately trashing it. The result is cached
 * for the lifetime of the process.
 */
async function getDataSourceId(): Promise<string> {
  if (_dataSourceId) return _dataSourceId;

  const notion = getClient();
  const dbId = getDbId();

  const probe = await notion.pages.create({
    parent: { database_id: dbId },
    properties: {
      'Name':        { title: [{ text: { content: '__probe__' } }] },
      'Profile URL': { url: 'https://www.linkedin.com/in/__probe__' },
    } as Parameters<typeof notion.pages.create>[0]['properties'],
  });

  let dsId: string;
  try {
    const retrieved = await notion.pages.retrieve({ page_id: probe.id });
    const parent = (retrieved as unknown as { parent: { data_source_id?: string; database_id?: string } }).parent;
    dsId = parent.data_source_id ?? parent.database_id ?? dbId;
  } finally {
    await notion.pages.update({ page_id: probe.id, in_trash: true } as Parameters<typeof notion.pages.update>[0]);
  }

  _dataSourceId = dsId!;
  return dsId!;
}

// ─── Find lead by profile URL ──────────────────────────────────────────────────

async function findLeadByUrl(profileUrl: string): Promise<string | null> {
  const notion = getClient();
  const normalizedUrl = profileUrl.trim().replace(/\/$/, '');
  const response = await notion.dataSources.query({
    data_source_id: await getDataSourceId(),
    filter: {
      property: 'Profile URL',
      url: { equals: normalizedUrl },
    },
    page_size: 1,
  });
  return response.results[0]?.id ?? null;
}

// ─── Upsert lead ─────────────────────────────────────────────────────────────

export async function upsertLead(lead: LinkedInLead): Promise<void> {
  const notion = getClient();
  const normalizedUrl = lead.profileUrl.trim().replace(/\/$/, '');
  const existingId = await findLeadByUrl(normalizedUrl);

  const props: Record<string, unknown> = {
    'Profile URL': { url: normalizedUrl },
  };

  // On create: always set Name (required field). On update: only overwrite if non-empty,
  // so a failed selector extraction doesn't clobber the existing name.
  if (lead.name) {
    props['Name'] = { title: [{ text: { content: lead.name } }] };
  } else if (!existingId) {
    props['Name'] = { title: [{ text: { content: 'Unknown' } }] };
  }

  if (lead.title)       props['Title']       = { rich_text: [{ text: { content: lead.title } }] };
  if (lead.company)     props['Company']     = { rich_text: [{ text: { content: lead.company } }] };
  if (lead.location)    props['Location']    = { rich_text: [{ text: { content: lead.location } }] };
  if (lead.email)       props['Email']       = { email: lead.email };
  if (lead.about)       props['About']       = { rich_text: [{ text: { content: lead.about.slice(0, 2000) } }] };
  if (lead.source)      props['Source']      = { select: { name: lead.source } };
  if (lead.status)      props['Status']      = { select: { name: lead.status } };
  if (lead.campaign)    props['Campaign']    = { rich_text: [{ text: { content: lead.campaign } }] };
  if (lead.notes)       props['Notes']       = { rich_text: [{ text: { content: lead.notes } }] };
  if (lead.messageSent) props['Message Sent'] = { rich_text: [{ text: { content: lead.messageSent } }] };

  props['Last Action'] = { date: { start: new Date().toISOString() } };

  if (existingId) {
    await notion.pages.update({ page_id: existingId, properties: props as Parameters<typeof notion.pages.update>[0]['properties'] });
  } else {
    await notion.pages.create({
      parent: { database_id: getDbId() },
      properties: props as Parameters<typeof notion.pages.create>[0]['properties'],
    });
  }
}

// ─── Update lead status ────────────────────────────────────────────────────────

export async function updateLeadStatus(profileUrl: string, status: LeadStatus, extra?: Partial<LinkedInLead>): Promise<void> {
  const notion = getClient();
  const normalizedUrl = profileUrl.trim().replace(/\/$/, '');
  const pageId = await findLeadByUrl(normalizedUrl);
  if (!pageId) {
    // Create minimal record if not found
    await upsertLead({ name: 'Unknown', profileUrl: normalizedUrl, status, ...extra });
    return;
  }

  const props: Record<string, unknown> = {
    'Status':      { select: { name: status } },
    'Last Action': { date: { start: new Date().toISOString() } },
  };

  if (extra?.messageSent) props['Message Sent'] = { rich_text: [{ text: { content: extra.messageSent } }] };
  if (extra?.notes)       props['Notes']        = { rich_text: [{ text: { content: extra.notes } }] };
  if (status === 'Connected') props['Connection Date'] = { date: { start: new Date().toISOString() } };

  await notion.pages.update({ page_id: pageId, properties: props as Parameters<typeof notion.pages.update>[0]['properties'] });
}

// ─── Get leads by status ──────────────────────────────────────────────────────

export async function getLeadsByStatus(status: LeadStatus, campaign?: string): Promise<LinkedInLead[]> {
  const notion = getClient();

  const filters: unknown[] = [
    { property: 'Status', select: { equals: status } },
  ];
  if (campaign) {
    filters.push({ property: 'Campaign', rich_text: { contains: campaign } });
  }

  const response = await notion.dataSources.query({
    data_source_id: await getDataSourceId(),
    filter: filters.length === 1 ? filters[0] as Parameters<typeof notion.dataSources.query>[0]['filter'] : { and: filters } as Parameters<typeof notion.dataSources.query>[0]['filter'],
    page_size: 100,
  });

  return response.results.map((page: unknown) => {
    const p = page as { properties: Record<string, unknown> };
    const props = p.properties;

    function getText(prop: unknown): string {
      if (!prop) return '';
      const p = prop as { rich_text?: Array<{ plain_text: string }>, title?: Array<{ plain_text: string }>, url?: string, email?: string, select?: { name: string } };
      if (p.rich_text?.length) return p.rich_text[0].plain_text;
      if (p.title?.length)     return p.title[0].plain_text;
      if (p.url)               return p.url;
      if (p.email)             return p.email;
      if (p.select?.name)      return p.select.name;
      return '';
    }

    return {
      name:       getText(props['Name']),
      profileUrl: getText(props['Profile URL']),
      title:      getText(props['Title']),
      company:    getText(props['Company']),
      location:   getText(props['Location']),
      email:      getText(props['Email']),
      about:      getText(props['About']),
      source:     getText(props['Source']),
      status:     getText(props['Status']) as LeadStatus,
      campaign:   getText(props['Campaign']),
      notes:      getText(props['Notes']),
      messageSent: getText(props['Message Sent']),
    };
  });
}

// ─── Campaign stats ───────────────────────────────────────────────────────────

export async function getCampaignStats(campaign?: string): Promise<Record<LeadStatus, number>> {
  const statuses: LeadStatus[] = ['New', 'Visited', 'Requested', 'Connected', 'Messaged', 'Replied', 'Archived'];
  const stats = {} as Record<LeadStatus, number>;

  await Promise.all(statuses.map(async (s) => {
    const leads = await getLeadsByStatus(s, campaign);
    stats[s] = leads.length;
  }));

  return stats;
}

/** For testing only — pre-seeds the data source ID cache to bypass the probe */
export function _setDataSourceId(id: string): void {
  _dataSourceId = id;
}
