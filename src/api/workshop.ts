/**
 * Blueprint Workshop — catalog proxy, cache, and route handlers.
 *
 * Fetches the workshop catalog from jsDelivr CDN, caches in memory,
 * and handles all /api/workshop/* routes.
 */
import crypto from 'crypto';
import { CronExpressionParser } from 'cron-parser';
import { IncomingMessage, ServerResponse } from 'http';

import {
  createInstalledBlueprint,
  createTask,
  deleteInstalledBlueprint,
  deleteTask,
  getInstalledBlueprint,
  getInstalledBlueprintByBlueprintId,
  getInstalledBlueprintsForGroup,
  getTaskById,
  updateInstalledBlueprint,
  updateTask,
} from '../db.js';
import type { InstalledBlueprint } from '../db.js';
import {
  renderBlueprintTemplate,
  validateRequiredParams,
} from '../blueprint-template.js';
import { logger } from '../logger.js';
import { parseJsonBody } from './cors.js';
import type { AuthUser } from './types.js';

// --- Types ---

export interface BlueprintParameter {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'select';
  required: boolean;
  default?: string | number | boolean;
  options?: string[];
  description?: string;
}

export interface BlueprintSpec {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  category: string;
  tags: string[];
  trigger_type: 'scheduled' | 'on-demand';
  schedule_default?: string;
  prompt_template: string;
  parameters: BlueprintParameter[];
  capabilities?: string[];
}

export interface CatalogIndex {
  version: string;
  blueprints: Array<{
    id: string;
    name: string;
    description: string;
    version: string;
    author: string;
    category: string;
    tags: string[];
    trigger_type: string;
  }>;
}

// --- Catalog cache ---

export const CATALOG_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

const DEFAULT_REGISTRY_URL =
  'https://cdn.jsdelivr.net/gh/davekim917/nanoclaw-workshop@latest';

function getRegistryUrl(): string {
  return process.env.WORKSHOP_REGISTRY_URL || DEFAULT_REGISTRY_URL;
}

let catalogCache: CatalogIndex | null = null;
let catalogCacheTime = 0;
let catalogEtag: string | null = null;

const specCache = new Map<string, { spec: BlueprintSpec; fetchedAt: number }>();

export async function fetchCatalog(
  forceRefresh?: boolean,
): Promise<CatalogIndex> {
  const now = Date.now();

  // Return cache if within TTL and not forced
  if (
    catalogCache &&
    !forceRefresh &&
    now - catalogCacheTime < CATALOG_CACHE_TTL_MS
  ) {
    return catalogCache;
  }

  const url = `${getRegistryUrl()}/index.json`;
  const headers: Record<string, string> = {};
  if (catalogEtag) {
    headers['If-None-Match'] = catalogEtag;
  }

  try {
    const response = await fetch(url, { headers });

    if (response.status === 304 && catalogCache) {
      catalogCacheTime = now;
      return catalogCache;
    }

    if (!response.ok) {
      if (catalogCache) {
        logger.warn(
          { status: response.status },
          'CDN returned non-200, serving stale cache',
        );
        return catalogCache;
      }
      throw new Error(`CDN returned ${response.status}`);
    }

    const data = (await response.json()) as CatalogIndex;
    catalogCache = data;
    catalogCacheTime = now;
    catalogEtag = response.headers.get('etag');
    specCache.clear(); // Invalidate spec cache when catalog refreshes
    return data;
  } catch (err) {
    if (catalogCache) {
      logger.warn({ err }, 'CDN fetch failed, serving stale cache');
      return catalogCache;
    }
    throw err;
  }
}

export async function fetchBlueprintSpec(
  blueprintId: string,
): Promise<BlueprintSpec> {
  const cached = specCache.get(blueprintId);
  if (cached && Date.now() - cached.fetchedAt < CATALOG_CACHE_TTL_MS) {
    return cached.spec;
  }

  const url = `${getRegistryUrl()}/blueprints/${blueprintId}.json`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Blueprint ${blueprintId} not found (${response.status})`);
  }

  const spec = (await response.json()) as BlueprintSpec;
  specCache.set(blueprintId, { spec, fetchedAt: Date.now() });
  return spec;
}

// --- Dependencies ---

export interface WorkshopDeps {
  hasGroupAccess: (auth: AuthUser | true, groupFolder: string) => boolean;
  getCapabilities: () => { channels?: string[] };
  triggerSchedulerPoll: () => void;
  getRegisteredGroups: () => Array<{
    jid: string;
    name: string;
    folder: string;
  }>;
}

// --- Helpers ---

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const VALID_BLUEPRINT_ID = /^[a-zA-Z0-9_-]+$/;

// --- Route dispatcher ---

export async function handleWorkshopRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string,
  auth: AuthUser | true,
  deps: WorkshopDeps,
): Promise<boolean> {
  // GET /api/workshop/catalog
  if (pathname === '/api/workshop/catalog' && method === 'GET') {
    try {
      const catalog = await fetchCatalog();
      json(res, 200, catalog);
    } catch (err) {
      logger.error({ err }, 'Failed to fetch workshop catalog');
      json(res, 502, { error: 'Failed to fetch catalog from registry' });
    }
    return true;
  }

  // GET /api/workshop/catalog/:id
  const catalogDetailMatch = pathname.match(
    /^\/api\/workshop\/catalog\/([^/]+)$/,
  );
  if (catalogDetailMatch && method === 'GET') {
    const blueprintId = decodeURIComponent(catalogDetailMatch[1]);
    if (!VALID_BLUEPRINT_ID.test(blueprintId)) {
      json(res, 400, { error: 'Invalid blueprint ID format' });
      return true;
    }
    try {
      const spec = await fetchBlueprintSpec(blueprintId);
      // Check integration status against capabilities
      const capabilities = deps.getCapabilities();
      const missingCapabilities = (spec.capabilities || []).filter(
        (c) => !(capabilities.channels || []).includes(c),
      );
      json(res, 200, {
        ...spec,
        integration_status: {
          satisfied: missingCapabilities.length === 0,
          missing: missingCapabilities,
        },
      });
    } catch (err) {
      logger.error({ err, blueprintId }, 'Failed to fetch blueprint spec');
      json(res, 404, { error: 'Blueprint not found' });
    }
    return true;
  }

  // GET /api/workshop/installed?group=<folder>
  if (pathname === '/api/workshop/installed' && method === 'GET') {
    const url = new URL(
      req.url || '/',
      `http://${req.headers.host || 'localhost'}`,
    );
    const groupFolder = url.searchParams.get('group');
    if (!groupFolder) {
      json(res, 400, { error: 'Missing required parameter: group' });
      return true;
    }
    if (!deps.hasGroupAccess(auth, groupFolder)) {
      json(res, 403, { error: 'Access denied to group' });
      return true;
    }

    const installed = getInstalledBlueprintsForGroup(groupFolder);

    // Enrich with update_available by comparing to catalog
    let catalog: CatalogIndex | null = null;
    try {
      catalog = await fetchCatalog();
    } catch {
      // Catalog unavailable — skip update check
    }

    const enriched = installed.map((bp) => {
      const catalogEntry = catalog?.blueprints.find(
        (c) => c.id === bp.blueprint_id,
      );
      return {
        ...bp,
        update_available: catalogEntry
          ? catalogEntry.version !== bp.blueprint_version
          : false,
      };
    });

    json(res, 200, { data: enriched });
    return true;
  }

  // POST /api/workshop/install
  if (pathname === '/api/workshop/install' && method === 'POST') {
    try {
      const body = await parseJsonBody<{
        blueprint_id?: string;
        group_folder?: string;
        chat_jid?: string;
        config?: Record<string, unknown>;
      }>(req);

      if (!body.blueprint_id || !body.group_folder || !body.chat_jid) {
        json(res, 400, {
          error: 'Missing required fields: blueprint_id, group_folder, chat_jid',
        });
        return true;
      }

      if (!VALID_BLUEPRINT_ID.test(body.blueprint_id)) {
        json(res, 400, { error: 'Invalid blueprint ID format' });
        return true;
      }

      if (!deps.hasGroupAccess(auth, body.group_folder)) {
        json(res, 403, { error: 'Access denied to group' });
        return true;
      }

      // Check if already installed
      const existing = getInstalledBlueprintByBlueprintId(
        body.blueprint_id,
        body.group_folder,
      );
      if (existing) {
        json(res, 409, {
          error: 'Blueprint already installed for this group',
          installed_id: existing.id,
        });
        return true;
      }

      // Fetch spec
      let spec: BlueprintSpec;
      try {
        spec = await fetchBlueprintSpec(body.blueprint_id);
      } catch {
        json(res, 404, { error: 'Blueprint not found in registry' });
        return true;
      }

      // Reject event-driven (removed from v1)
      if ((spec.trigger_type as string) === 'event-driven') {
        json(res, 400, {
          error: 'Event-driven blueprints are not supported in this version',
        });
        return true;
      }

      // Validate cron expression for scheduled blueprints
      if (spec.trigger_type === 'scheduled') {
        const cronExpr = spec.schedule_default || '0 9 * * *';
        try {
          CronExpressionParser.parse(cronExpr);
        } catch {
          json(res, 400, {
            error: `Invalid cron expression in blueprint: ${cronExpr}`,
          });
          return true;
        }
      }

      // Validate required params
      const config = body.config || {};
      const missingParams = validateRequiredParams(spec.parameters, config);
      if (missingParams.length > 0) {
        json(res, 400, {
          error: `Missing required parameters: ${missingParams.join(', ')}`,
          missing_params: missingParams,
        });
        return true;
      }

      // Resolve system vars
      const group = deps
        .getRegisteredGroups()
        .find((g) => g.folder === body.group_folder);
      const systemVars = {
        group_name: group?.name || body.group_folder,
        group_folder: body.group_folder,
        chat_channel: group?.name || 'unknown',
      };

      // Build template params from config
      const templateParams: Record<string, string | number | boolean> = {};
      for (const param of spec.parameters) {
        const value = config[param.key];
        if (value !== undefined && value !== null) {
          templateParams[param.key] = value as string | number | boolean;
        } else if (param.default !== undefined) {
          templateParams[param.key] = param.default;
        }
      }

      const { rendered } = renderBlueprintTemplate(
        spec.prompt_template,
        templateParams,
        systemVars,
      );

      const installId = crypto.randomUUID();
      const scheduledTaskId =
        spec.trigger_type === 'scheduled' ? crypto.randomUUID() : undefined;

      // Create blueprint record first — UNIQUE constraint fails fast on
      // concurrent duplicate installs, before any task is created.
      try {
        createInstalledBlueprint({
          id: installId,
          blueprint_id: body.blueprint_id,
          blueprint_version: spec.version,
          group_folder: body.group_folder,
          chat_jid: body.chat_jid,
          config: JSON.stringify(config),
          rendered_prompt: rendered,
          trigger_type: spec.trigger_type,
          scheduled_task_id: scheduledTaskId,
        });
      } catch (err) {
        // UNIQUE constraint violation → concurrent duplicate install
        const msg =
          err instanceof Error ? err.message : String(err);
        if (msg.includes('UNIQUE constraint')) {
          json(res, 409, {
            error: 'Blueprint already installed for this group',
          });
          return true;
        }
        throw err;
      }

      // Create scheduled task after blueprint is safely persisted
      if (scheduledTaskId) {
        createTask({
          id: scheduledTaskId,
          group_folder: body.group_folder,
          chat_jid: body.chat_jid,
          prompt: rendered,
          schedule_type: 'cron',
          schedule_value: spec.schedule_default || '0 9 * * *',
          context_mode: 'isolated',
          task_type: 'container',
          next_run: new Date().toISOString(),
          status: 'active',
          created_at: new Date().toISOString(),
          blueprint_id: body.blueprint_id,
        });
      }

      json(res, 201, {
        id: installId,
        blueprint_id: body.blueprint_id,
        status: 'active',
        scheduled_task_id: scheduledTaskId || null,
      });
    } catch (err) {
      logger.error({ err }, 'Failed to install blueprint');
      json(res, 500, { error: 'Failed to install blueprint' });
    }
    return true;
  }

  // Match /api/workshop/installed/:id patterns
  const installedIdMatch = pathname.match(
    /^\/api\/workshop\/installed\/([^/]+)$/,
  );
  const installedToggleMatch = pathname.match(
    /^\/api\/workshop\/installed\/([^/]+)\/toggle$/,
  );
  const installedRunMatch = pathname.match(
    /^\/api\/workshop\/installed\/([^/]+)\/run$/,
  );
  const installedConfigureMatch = pathname.match(
    /^\/api\/workshop\/installed\/([^/]+)\/configure$/,
  );

  // POST /api/workshop/installed/:id/toggle
  if (installedToggleMatch && method === 'POST') {
    const id = decodeURIComponent(installedToggleMatch[1]);
    const bp = getInstalledBlueprint(id);
    if (!bp) {
      json(res, 404, { error: 'Installed blueprint not found' });
      return true;
    }
    if (!deps.hasGroupAccess(auth, bp.group_folder)) {
      json(res, 403, { error: 'Access denied to group' });
      return true;
    }

    const newStatus = bp.status === 'active' ? 'paused' : 'active';
    updateInstalledBlueprint(id, { status: newStatus });

    // Sync linked scheduled task
    if (bp.scheduled_task_id) {
      const task = getTaskById(bp.scheduled_task_id);
      if (task) {
        updateTask(bp.scheduled_task_id, {
          status: newStatus === 'active' ? 'active' : 'paused',
        });
      }
    }

    json(res, 200, { ok: true, status: newStatus });
    return true;
  }

  // POST /api/workshop/installed/:id/run
  if (installedRunMatch && method === 'POST') {
    const id = decodeURIComponent(installedRunMatch[1]);
    const bp = getInstalledBlueprint(id);
    if (!bp) {
      json(res, 404, { error: 'Installed blueprint not found' });
      return true;
    }
    if (!deps.hasGroupAccess(auth, bp.group_folder)) {
      json(res, 403, { error: 'Access denied to group' });
      return true;
    }

    // Create a once-type task for immediate execution
    const taskId = crypto.randomUUID();
    createTask({
      id: taskId,
      group_folder: bp.group_folder,
      chat_jid: bp.chat_jid,
      prompt: bp.rendered_prompt,
      schedule_type: 'once',
      schedule_value: '',
      context_mode: 'isolated',
      task_type: 'container',
      next_run: new Date().toISOString(),
      status: 'active',
      created_at: new Date().toISOString(),
      blueprint_id: bp.blueprint_id,
    });

    deps.triggerSchedulerPoll();
    json(res, 200, { ok: true, task_id: taskId });
    return true;
  }

  // POST /api/workshop/installed/:id/configure
  if (installedConfigureMatch && method === 'POST') {
    const id = decodeURIComponent(installedConfigureMatch[1]);
    const bp = getInstalledBlueprint(id);
    if (!bp) {
      json(res, 404, { error: 'Installed blueprint not found' });
      return true;
    }
    if (!deps.hasGroupAccess(auth, bp.group_folder)) {
      json(res, 403, { error: 'Access denied to group' });
      return true;
    }

    try {
      const body = await parseJsonBody<{
        config?: Record<string, unknown>;
      }>(req);
      if (!body.config) {
        json(res, 400, { error: 'Missing required field: config' });
        return true;
      }

      // Fetch spec to re-render
      let spec: BlueprintSpec;
      try {
        spec = await fetchBlueprintSpec(bp.blueprint_id);
      } catch {
        json(res, 404, { error: 'Blueprint spec no longer available' });
        return true;
      }

      const missingParams = validateRequiredParams(
        spec.parameters,
        body.config,
      );
      if (missingParams.length > 0) {
        json(res, 400, {
          error: `Missing required parameters: ${missingParams.join(', ')}`,
          missing_params: missingParams,
        });
        return true;
      }

      const group = deps
        .getRegisteredGroups()
        .find((g) => g.folder === bp.group_folder);
      const systemVars = {
        group_name: group?.name || bp.group_folder,
        group_folder: bp.group_folder,
        chat_channel: group?.name || 'unknown',
      };

      const templateParams: Record<string, string | number | boolean> = {};
      for (const param of spec.parameters) {
        const value = body.config[param.key];
        if (value !== undefined && value !== null) {
          templateParams[param.key] = value as string | number | boolean;
        } else if (param.default !== undefined) {
          templateParams[param.key] = param.default;
        }
      }

      const { rendered } = renderBlueprintTemplate(
        spec.prompt_template,
        templateParams,
        systemVars,
      );

      updateInstalledBlueprint(id, {
        config: JSON.stringify(body.config),
        rendered_prompt: rendered,
      });

      // Update linked scheduled task prompt
      if (bp.scheduled_task_id) {
        const task = getTaskById(bp.scheduled_task_id);
        if (task) {
          updateTask(bp.scheduled_task_id, { prompt: rendered });
        }
      }

      json(res, 200, { ok: true, rendered_prompt: rendered });
    } catch (err) {
      logger.error({ err }, 'Failed to configure blueprint');
      json(res, 500, { error: 'Failed to configure blueprint' });
    }
    return true;
  }

  // DELETE /api/workshop/installed/:id
  if (installedIdMatch && method === 'DELETE') {
    const id = decodeURIComponent(installedIdMatch[1]);
    const bp = getInstalledBlueprint(id);
    if (!bp) {
      json(res, 404, { error: 'Installed blueprint not found' });
      return true;
    }
    if (!deps.hasGroupAccess(auth, bp.group_folder)) {
      json(res, 403, { error: 'Access denied to group' });
      return true;
    }

    // Delete linked scheduled task first
    if (bp.scheduled_task_id) {
      deleteTask(bp.scheduled_task_id);
    }

    deleteInstalledBlueprint(id);
    json(res, 200, { ok: true });
    return true;
  }

  return false;
}
