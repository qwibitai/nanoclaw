/**
 * Gera os links de OAuth (session.authorize) por agente + toolkit.
 * Imprime tudo agrupado por agente pra você abrir um a um no navegador.
 */
import { Composio } from '@composio/core';
import Database from 'better-sqlite3';

const apiKey = process.env.COMPOSIO_API_KEY;
if (!apiKey) { console.error('Set COMPOSIO_API_KEY'); process.exit(1); }

const ALL = ['googledrive', 'googlesheets', 'googledocs', 'tavily'];
const MATRIX = {
  Zory: ['gmail', 'googledrive', 'googlesheets', 'googledocs', 'googlecalendar', 'google_analytics', 'github', 'instagram', 'metaads', 'neon', 'cloudflare', 'short_io', 'tavily'],
  Caio: ALL,
  Lad: ALL,
  Grow: ALL,
  Naia: ['googlesheets', 'googledrive', 'tavily'],
};

const db = new Database('/root/nanoclaw/data/v2.db', { readonly: true });
const groups = db.prepare('SELECT id, name, folder FROM agent_groups').all();

const composio = new Composio({ apiKey });

for (const g of groups) {
  const toolkits = MATRIX[g.name];
  if (!toolkits) continue;

  console.log(`\n==================== ${g.name} (${toolkits.length} links) ====================`);
  console.log(`user_id: ${g.id}\n`);

  const session = await composio.create(g.id);

  for (const slug of toolkits) {
    try {
      const req = await session.authorize(slug);
      console.log(`[${slug}]`);
      console.log(`  ${req.redirectUrl}`);
      console.log();
    } catch (err) {
      console.log(`[${slug}] ERROR: ${err.message}`);
      if (err.response) console.log('  resp:', JSON.stringify(err.response).slice(0, 200));
      console.log();
    }
  }
}

console.log('\nPronto. Abra cada link, autentique, e depois rode o audit novamente pra confirmar.');
