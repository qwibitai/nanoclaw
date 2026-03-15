/**
 * Knowledge Base management routes.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import {
  createKnowledgeBase,
  deleteKnowledgeBase,
  getKnowledgeBase,
  getAllKnowledgeBases,
  updateKnowledgeBase,
  addKBDocument,
  getKBDocuments,
  deleteKBDocument,
  getAgent,
  PortalKnowledgeBase,
  PortalKBDocument,
} from '../db-portal.js';
import { json, error, RequestContext } from '../server.js';

function getKBStoragePath(kb: PortalKnowledgeBase): string {
  if (kb.scope === 'global') {
    return path.join(GROUPS_DIR, 'global', 'kb');
  }
  if (kb.assigned_agent_id) {
    const agent = getAgent(kb.assigned_agent_id);
    if (agent) {
      return path.join(GROUPS_DIR, agent.group_folder, 'kb');
    }
  }
  return path.join(GROUPS_DIR, 'global', 'kb');
}

export async function handleKBRoutes(ctx: RequestContext): Promise<void> {
  const { method, pathname, body, res, req } = ctx;

  // GET /api/kb
  if (method === 'GET' && pathname === '/api/kb') {
    const kbs = getAllKnowledgeBases();
    const enriched = kbs.map((kb) => ({
      ...kb,
      documents: getKBDocuments(kb.id),
    }));
    json(res, enriched);
    return;
  }

  // POST /api/kb
  if (method === 'POST' && pathname === '/api/kb') {
    const data = body as Partial<PortalKnowledgeBase> & { name: string };
    if (!data?.name) {
      error(res, 'KB name is required');
      return;
    }
    const kb = createKnowledgeBase({
      name: data.name,
      scope: data.scope || 'global',
      assigned_agent_id: data.assigned_agent_id || null,
      description: data.description || null,
    });

    // Create storage directory
    const storagePath = getKBStoragePath(kb);
    fs.mkdirSync(path.join(storagePath, kb.id), { recursive: true });

    json(res, kb, 201);
    return;
  }

  // Routes with KB ID
  const kbIdMatch = pathname.match(/^\/api\/kb\/([^/]+)(\/.*)?$/);
  if (!kbIdMatch) {
    error(res, 'Not Found', 404);
    return;
  }

  const kbId = kbIdMatch[1];
  const subPath = kbIdMatch[2] || '';

  // GET /api/kb/:id
  if (method === 'GET' && subPath === '') {
    const kb = getKnowledgeBase(kbId);
    if (!kb) {
      error(res, 'Knowledge base not found', 404);
      return;
    }
    json(res, {
      ...kb,
      documents: getKBDocuments(kbId),
    });
    return;
  }

  // PUT /api/kb/:id
  if (method === 'PUT' && subPath === '') {
    const kb = getKnowledgeBase(kbId);
    if (!kb) {
      error(res, 'Knowledge base not found', 404);
      return;
    }
    const data = body as Partial<PortalKnowledgeBase>;
    updateKnowledgeBase(kbId, {
      name: data.name,
      scope: data.scope,
      assigned_agent_id: data.assigned_agent_id,
      description: data.description,
    });
    json(res, getKnowledgeBase(kbId));
    return;
  }

  // DELETE /api/kb/:id
  if (method === 'DELETE' && subPath === '') {
    deleteKnowledgeBase(kbId);
    json(res, { ok: true });
    return;
  }

  // POST /api/kb/:id/documents — Upload a document
  if (method === 'POST' && subPath === '/documents') {
    const kb = getKnowledgeBase(kbId);
    if (!kb) {
      error(res, 'Knowledge base not found', 404);
      return;
    }

    const data = body as { filename: string; content: string; mime_type?: string } | null;
    if (!data?.filename || !data?.content) {
      error(res, 'filename and content (base64) are required');
      return;
    }

    const storagePath = getKBStoragePath(kb);
    const docDir = path.join(storagePath, kbId);
    fs.mkdirSync(docDir, { recursive: true });

    // Sanitize filename
    const safeName = path.basename(data.filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = path.join(docDir, safeName);

    // Write file (content is base64 encoded)
    const buffer = Buffer.from(data.content, 'base64');
    fs.writeFileSync(filePath, buffer);

    const doc = addKBDocument({
      kb_id: kbId,
      filename: safeName,
      file_path: path.relative(GROUPS_DIR, filePath),
      file_size: buffer.length,
      mime_type: data.mime_type || 'application/octet-stream',
    });

    json(res, doc, 201);
    return;
  }

  // DELETE /api/kb/:id/documents/:docId
  const docMatch = subPath.match(/^\/documents\/([^/]+)$/);
  if (method === 'DELETE' && docMatch) {
    deleteKBDocument(docMatch[1]);
    json(res, { ok: true });
    return;
  }

  error(res, 'Not Found', 404);
}
