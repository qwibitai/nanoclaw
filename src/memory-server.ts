import express from 'express';

import { logger } from './logger.js';
import { searchMemory, getEmbeddingCount } from './embeddings.js';

const PORT = 7832;

export function startMemoryServer(): void {
  const app = express();
  app.use(express.json());

  app.post('/search', async (req, res) => {
    const { query, limit, chatJid } = req.body;
    if (!query || typeof query !== 'string') {
      res.status(400).json({ error: 'query is required' });
      return;
    }

    try {
      const results = await searchMemory(query, limit || 10, chatJid);
      res.json({ results });
    } catch (err) {
      logger.error({ err }, 'Memory search error');
      res.status(500).json({ error: 'search failed' });
    }
  });

  app.get('/stats', (_req, res) => {
    res.json({ count: getEmbeddingCount() });
  });

  app.listen(PORT, '0.0.0.0', () => {
    logger.info({ port: PORT }, 'Memory search server started');
  });
}
