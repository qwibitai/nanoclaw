import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { closeAll } from './auth.js';

const VALID_MODULES = ['calendar', 'contacts', 'mail', 'notes'] as const;
type ModuleName = (typeof VALID_MODULES)[number];

export function parseModules(): ModuleName[] {
  const raw = process.env.ICLOUD_MODULES ?? '';
  const names = raw.split(',').map(s => s.trim()).filter(Boolean);
  for (const name of names) {
    if (!VALID_MODULES.includes(name as ModuleName)) {
      throw new Error(`Unknown module: ${name}. Valid modules: ${VALID_MODULES.join(', ')}`);
    }
  }
  return names as ModuleName[];
}

const MODULE_LOADERS: Record<ModuleName, (server: McpServer) => Promise<void>> = {
  calendar: async (server) => {
    const { registerCalendar } = await import('./modules/calendar.js');
    registerCalendar(server);
  },
  contacts: async (server) => {
    const { registerContacts } = await import('./modules/contacts.js');
    registerContacts(server);
  },
  mail: async (server) => {
    const { registerMail } = await import('./modules/mail.js');
    registerMail(server);
  },
  notes: async (server) => {
    const { registerNotes } = await import('./modules/notes.js');
    registerNotes(server);
  },
};

async function main() {
  const modules = parseModules();
  if (modules.length === 0) {
    console.error('Warning: ICLOUD_MODULES is empty — no tools will be registered');
  }

  const server = new McpServer({
    name: 'icloud-tools',
    version: '1.0.0',
  });

  for (const mod of modules) {
    await MODULE_LOADERS[mod](server);
  }

  // Graceful shutdown
  process.on('SIGINT', async () => {
    await closeAll();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await closeAll();
    process.exit(0);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only run main() when executed directly, not when imported in tests
if (!process.env.VITEST) {
  main().catch((err) => {
    console.error('icloud-tools server failed to start:', err);
    process.exit(1);
  });
}
