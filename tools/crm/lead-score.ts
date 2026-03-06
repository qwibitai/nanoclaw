#!/usr/bin/env npx tsx
/**
 * Lead Scoring Engine for NanoClaw
 *
 * Scores CRM contacts 0-100 based on title, industry, location, and data quality.
 * Helps prioritize outreach to the most promising leads.
 *
 * Usage:
 *   npx tsx tools/crm/lead-score.ts score --contact-id <id>
 *   npx tsx tools/crm/lead-score.ts batch [--source apollo] [--limit 100]
 *   npx tsx tools/crm/lead-score.ts top [--limit 20]
 */

import Database from 'better-sqlite3';
import { getDbPath } from '../shared/db-path.js';
import fs from 'fs';
import path from 'path';

interface ScoringConfig {
  titleKeywords: Record<string, number>;
  industryKeywords: Record<string, number>;
  locationBonus: Record<string, number>;
  dataQuality: Record<string, number>;
  companyKeywords: Record<string, number>;
}

interface ContactRow {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  company: string | null;
  title: string | null;
  linkedin_url: string | null;
  phone: string | null;
  source: string;
  website: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  industry: string | null;
}

interface Args {
  action: string;
  contactId?: string;
  source?: string;
  limit: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const action = argv[0];

  if (!['score', 'batch', 'top'].includes(action)) {
    console.error(JSON.stringify({
      status: 'error',
      error: `Unknown action "${action}". Use: score, batch, top`,
      usage: [
        'npx tsx tools/crm/lead-score.ts score --contact-id <id>',
        'npx tsx tools/crm/lead-score.ts batch [--source apollo] [--limit 100]',
        'npx tsx tools/crm/lead-score.ts top [--limit 20]',
      ],
    }));
    process.exit(1);
  }

  const flags: Record<string, string> = {};
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith('--') && i + 1 < argv.length) {
      flags[argv[i].slice(2)] = argv[++i];
    }
  }

  return {
    action,
    contactId: flags['contact-id'],
    source: flags.source,
    limit: parseInt(flags.limit || '100', 10),
  };
}

function getDb(): Database.Database {
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    console.error(JSON.stringify({ status: 'error', error: 'Database not found. Run NanoClaw first.' }));
    process.exit(1);
  }
  return new Database(dbPath);
}

function loadConfig(): ScoringConfig {
  const configPath = path.join(process.cwd(), 'tools', 'crm', 'scoring-config.json');
  if (!fs.existsSync(configPath)) {
    console.error(JSON.stringify({ status: 'error', error: 'scoring-config.json not found' }));
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

function scoreContact(contact: ContactRow, config: ScoringConfig): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  // Title scoring
  if (contact.title) {
    const titleLower = contact.title.toLowerCase();
    for (const [keyword, points] of Object.entries(config.titleKeywords)) {
      if (titleLower.includes(keyword.toLowerCase())) {
        score += points;
        reasons.push(`title:"${keyword}" +${points}`);
        break; // Only count the best title match
      }
    }
  }

  // Industry scoring
  if (contact.industry) {
    const industryLower = contact.industry.toLowerCase();
    for (const [keyword, points] of Object.entries(config.industryKeywords)) {
      if (industryLower.includes(keyword.toLowerCase())) {
        score += points;
        reasons.push(`industry:"${keyword}" +${points}`);
        break;
      }
    }
  }

  // Company name scoring (catches industry signals from company name)
  if (contact.company) {
    const companyLower = contact.company.toLowerCase();
    for (const [keyword, points] of Object.entries(config.companyKeywords)) {
      if (companyLower.includes(keyword.toLowerCase())) {
        score += points;
        reasons.push(`company:"${keyword}" +${points}`);
        break; // Only count the best match
      }
    }
  }

  // Location scoring
  const locationFields = [contact.city, contact.state, contact.address].filter(Boolean).join(' ');
  if (locationFields) {
    for (const [location, points] of Object.entries(config.locationBonus)) {
      if (locationFields.toLowerCase().includes(location.toLowerCase())) {
        score += points;
        reasons.push(`location:"${location}" +${points}`);
        break; // Only count the best location match
      }
    }
  }

  // Data quality scoring
  const isPlaceholderEmail = contact.email.endsWith('@maps.nanoclaw') || contact.email.endsWith('@sms.nanoclaw');
  if (contact.email && !isPlaceholderEmail) {
    score += config.dataQuality.hasEmail || 0;
    reasons.push(`hasEmail +${config.dataQuality.hasEmail}`);
  }
  if (contact.phone) {
    score += config.dataQuality.hasPhone || 0;
    reasons.push(`hasPhone +${config.dataQuality.hasPhone}`);
  }
  if (contact.linkedin_url) {
    score += config.dataQuality.hasLinkedIn || 0;
    reasons.push(`hasLinkedIn +${config.dataQuality.hasLinkedIn}`);
  }
  if (contact.title) {
    score += config.dataQuality.hasTitle || 0;
    reasons.push(`hasTitle +${config.dataQuality.hasTitle}`);
  }
  if (contact.website) {
    score += config.dataQuality.hasWebsite || 0;
    reasons.push(`hasWebsite +${config.dataQuality.hasWebsite}`);
  }
  if (contact.address) {
    score += config.dataQuality.hasAddress || 0;
    reasons.push(`hasAddress +${config.dataQuality.hasAddress}`);
  }

  // Cap at 100
  return { score: Math.min(score, 100), reasons };
}

function main() {
  const args = parseArgs();
  const config = loadConfig();
  const db = getDb();

  try {
    switch (args.action) {
      case 'score': {
        if (!args.contactId) {
          console.error(JSON.stringify({ status: 'error', error: 'score requires --contact-id' }));
          process.exit(1);
        }

        const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(args.contactId) as ContactRow | undefined;
        if (!contact) {
          console.error(JSON.stringify({ status: 'error', error: `Contact ${args.contactId} not found` }));
          process.exit(1);
        }

        const { score, reasons } = scoreContact(contact, config);

        // Update the contact's score
        db.prepare(
          `UPDATE contacts SET lead_score = ?, lead_score_reasons = ?, updated_at = ? WHERE id = ?`,
        ).run(score, JSON.stringify(reasons), new Date().toISOString(), args.contactId);

        console.log(JSON.stringify({
          status: 'success',
          action: 'score',
          contact_id: args.contactId,
          name: `${contact.first_name} ${contact.last_name}`.trim(),
          company: contact.company,
          score,
          reasons,
        }));
        break;
      }

      case 'batch': {
        let query = 'SELECT * FROM contacts';
        const params: unknown[] = [];

        if (args.source) {
          query += ' WHERE source = ?';
          params.push(args.source);
        }
        query += ' ORDER BY created_at ASC LIMIT ?';
        params.push(args.limit);

        const contacts = db.prepare(query).all(...params) as ContactRow[];

        const updateStmt = db.prepare(
          `UPDATE contacts SET lead_score = ?, lead_score_reasons = ?, updated_at = ? WHERE id = ?`,
        );
        const now = new Date().toISOString();

        let scored = 0;
        const updateMany = db.transaction((contacts: ContactRow[]) => {
          for (const contact of contacts) {
            const { score, reasons } = scoreContact(contact, config);
            updateStmt.run(score, JSON.stringify(reasons), now, contact.id);
            scored++;
          }
        });
        updateMany(contacts);

        // Get score distribution
        const distribution = db.prepare(
          `SELECT
             SUM(CASE WHEN lead_score >= 80 THEN 1 ELSE 0 END) as hot,
             SUM(CASE WHEN lead_score >= 50 AND lead_score < 80 THEN 1 ELSE 0 END) as warm,
             SUM(CASE WHEN lead_score >= 20 AND lead_score < 50 THEN 1 ELSE 0 END) as cool,
             SUM(CASE WHEN lead_score < 20 THEN 1 ELSE 0 END) as cold
           FROM contacts`,
        ).get() as { hot: number; warm: number; cool: number; cold: number };

        console.log(JSON.stringify({
          status: 'success',
          action: 'batch',
          scored,
          source: args.source || 'all',
          distribution,
        }));
        break;
      }

      case 'top': {
        const contacts = db.prepare(
          `SELECT c.id, c.email, c.first_name, c.last_name, c.company, c.title, c.phone,
                  c.lead_score, c.city, c.state, c.source, c.industry
           FROM contacts c
           LEFT JOIN outreach_log o ON c.id = o.contact_id
           WHERE o.id IS NULL
             AND (c.tags IS NULL OR c.tags NOT LIKE '%do-not-contact%')
           ORDER BY c.lead_score DESC
           LIMIT ?`,
        ).all(args.limit) as Array<ContactRow & { lead_score: number }>;

        console.log(JSON.stringify({
          status: 'success',
          action: 'top',
          count: contacts.length,
          contacts: contacts.map((c) => ({
            id: c.id,
            name: `${c.first_name} ${c.last_name}`.trim(),
            company: c.company,
            title: c.title,
            email: c.email,
            phone: c.phone,
            score: c.lead_score,
            city: c.city,
            state: c.state,
            source: c.source,
            industry: c.industry,
          })),
        }));
        break;
      }
    }
  } catch (err) {
    console.error(JSON.stringify({
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    }));
    process.exit(1);
  } finally {
    db.close();
  }
}

main();
