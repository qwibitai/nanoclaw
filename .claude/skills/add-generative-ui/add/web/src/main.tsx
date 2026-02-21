import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

import * as JsonRenderReact from '@json-render/react';
import * as JsonRenderShadcn from '@json-render/shadcn';

import './styles.css';

type JsonRecord = Record<string, unknown>;

type GroupEntry = {
  jid: string;
  name: string;
  folder: string;
};

type JsonRenderSpec = {
  root: string | null;
  elements: Record<string, unknown>;
};

type CanvasStatePayload = {
  group: GroupEntry;
  groupFolder: string;
  spec: unknown;
  revision: number;
  updatedAt: string | null;
  canvasUrl?: string;
};

const RendererFromLibrary = (JsonRenderReact as JsonRecord).Renderer as
  | React.ComponentType<{
      spec?: JsonRenderSpec;
      tree?: unknown;
      componentMap?: JsonRecord;
      registry?: JsonRecord;
      onAction?: (...args: unknown[]) => void;
    }>
  | undefined;

const JSONUIProvider = (JsonRenderReact as JsonRecord).JSONUIProvider as
  | React.ComponentType<{ registry?: JsonRecord; children: React.ReactNode }>
  | undefined;

const defineRegistry = (JsonRenderReact as JsonRecord).defineRegistry as
  | ((catalog: JsonRecord, options: { components?: JsonRecord }) =>
      | JsonRecord
      | { registry?: JsonRecord })
  | undefined;

const shadcnExports = JsonRenderShadcn as JsonRecord;
const shadcnComponents =
  (shadcnExports.shadcnComponents as JsonRecord | undefined) ||
  (shadcnExports.shadcnComponentDefinitions as JsonRecord | undefined);

const registry: JsonRecord | undefined = (() => {
  if (!defineRegistry || !shadcnComponents) return undefined;
  const result = defineRegistry({}, { components: shadcnComponents });
  const base =
    result &&
    typeof result === 'object' &&
    'registry' in result &&
    result.registry &&
    typeof result.registry === 'object'
      ? (result.registry as JsonRecord)
      : (result as JsonRecord);
  // Alias legacy names the agent may produce
  if (!base.Container && base.Stack) base.Container = base.Stack;
  if (!base.Box && base.Stack) base.Box = base.Stack;
  if (!base.Paragraph && base.Text) base.Paragraph = base.Text;
  return base;
})();

function normalizeElement(el: unknown): unknown {
  if (!el || typeof el !== 'object' || Array.isArray(el)) return el;
  const elem = el as JsonRecord;
  // Map legacy "component" field to "type" expected by @json-render/react
  if (elem.component !== undefined && elem.type === undefined) {
    return { ...elem, type: elem.component };
  }
  return elem;
}

function coerceSpec(input: unknown): JsonRenderSpec | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }

  const value = input as JsonRecord;
  const root = typeof value.root === 'string' || value.root === null
    ? value.root
    : null;
  const rawElements =
    value.elements && typeof value.elements === 'object' && !Array.isArray(value.elements)
      ? (value.elements as Record<string, unknown>)
      : {};

  const elements: Record<string, unknown> = {};
  for (const [key, el] of Object.entries(rawElements)) {
    elements[key] = normalizeElement(el);
  }

  return { root, elements };
}

function handleAction(...args: unknown[]): void {
  const [actionName, maybePayload] = args;

  let name = '';
  let payload: JsonRecord = {};

  if (typeof actionName === 'string') {
    name = actionName;
  } else if (actionName && typeof actionName === 'object') {
    const value = actionName as JsonRecord;
    if (typeof value.action === 'string') {
      name = value.action;
    } else if (typeof value.name === 'string') {
      name = value.name;
    }

    if (value.payload && typeof value.payload === 'object' && !Array.isArray(value.payload)) {
      payload = value.payload as JsonRecord;
    }
  }

  if (maybePayload && typeof maybePayload === 'object' && !Array.isArray(maybePayload)) {
    payload = maybePayload as JsonRecord;
  }

  if (name === 'open_url') {
    const url = payload.url;
    if (typeof url === 'string' && url.length > 0) {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }
}

function CanvasRenderer({ spec }: { spec: JsonRenderSpec }) {
  if (!RendererFromLibrary) {
    return (
      <div className="placeholder">
        json-render Renderer is unavailable. Raw spec shown in the state panel.
      </div>
    );
  }

  const rendererProps: JsonRecord = { spec, onAction: handleAction };
  if (registry) rendererProps.registry = registry;

  const rendered = React.createElement(RendererFromLibrary, rendererProps);

  if (JSONUIProvider) {
    const providerProps: JsonRecord = { children: rendered };
    if (registry) providerProps.registry = registry;
    return React.createElement(JSONUIProvider, providerProps, rendered);
  }

  return rendered;
}

function App() {
  const [groups, setGroups] = useState<GroupEntry[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<string>('');
  const [state, setState] = useState<CanvasStatePayload | null>(null);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    const loadGroups = async () => {
      try {
        const response = await fetch('/api/canvas/groups');
        const payload = (await response.json()) as { groups: GroupEntry[] };
        const nextGroups = Array.isArray(payload.groups) ? payload.groups : [];
        setGroups(nextGroups);

        const requestedGroup = new URLSearchParams(window.location.search).get('group');
        const initialGroup = requestedGroup || nextGroups[0]?.folder || '';
        setSelectedGroup(initialGroup);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    };

    loadGroups().catch(() => {
      // handled in loadGroups
    });
  }, []);

  useEffect(() => {
    if (!selectedGroup) return;

    let cancelled = false;

    const loadState = async () => {
      try {
        const response = await fetch(`/api/canvas/${selectedGroup}/state`);
        const payload = (await response.json()) as
          | CanvasStatePayload
          | { error?: string };
        if (cancelled) return;

        if (!response.ok) {
          const message =
            typeof (payload as { error?: string }).error === 'string'
              ? ((payload as { error?: string }).error as string)
              : `Failed to load canvas state (${response.status})`;
          setError(message);
          return;
        }

        setState(payload as CanvasStatePayload);
        setError('');
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    };

    loadState().catch(() => {
      // handled in loadState
    });
    const interval = setInterval(loadState, 1500);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [selectedGroup]);

  const spec = useMemo(() => coerceSpec(state?.spec), [state?.spec]);

  return (
    <div className="layout">
      <section className="panel">
        <header className="panel-header">
          <h1>Generative Canvas</h1>
          <div className="controls">
            <select
              value={selectedGroup}
              onChange={(event) => setSelectedGroup(event.target.value)}
            >
              {groups.map((group) => (
                <option key={group.jid} value={group.folder}>
                  {group.name}
                </option>
              ))}
            </select>
          </div>
        </header>
        <div className="canvas-body">
          {error ? <div className="placeholder">{error}</div> : null}
          {!error && spec ? <CanvasRenderer spec={spec} /> : null}
          {!error && !spec ? (
            <div className="placeholder">
              No canvas state yet. Ask NanoClaw to call
              {' '}
              <code>mcp__nanoclaw__update_canvas</code>
              {' '}
              with SpecStream
              {' '}
              <code>events_jsonl</code>
              {' '}
              operations.
            </div>
          ) : null}
        </div>
      </section>
      <aside className="panel sidebar">
        <header className="panel-header">
          <h2>State</h2>
          <p className="meta">
            rev
            {' '}
            {state?.revision ?? 0}
            {' · '}
            {state?.updatedAt ? new Date(state.updatedAt).toLocaleTimeString() : 'never'}
          </p>
        </header>
        <pre>{JSON.stringify(state?.spec ?? {}, null, 2)}</pre>
      </aside>
    </div>
  );
}

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Missing #root mount element');
}

createRoot(rootEl).render(<App />);
