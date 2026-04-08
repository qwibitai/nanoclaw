/**
 * Vault knowledge graph view.
 *
 * Chrome rebuilt with Tailwind primitives; the D3 force simulation
 * itself is ported verbatim from the previous dashboard (see
 * src/vault/useVaultSimulation.ts). Behavior parity with the old
 * Vault is the bar — drag / zoom / hover-dim / search / click-to-
 * detail / legend domain toggle all mirror the old implementation.
 *
 * This view is lazy-loaded by the router so D3 only reaches the
 * initial bundle when the user actually navigates to /vault.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError, fetchVaultGraph } from "@/lib/api";
import { queryKeys } from "@/lib/query";
import { DomainColorMap } from "@/vault/domainColors";
import {
  useVaultSimulation,
  type VaultHandle,
} from "@/vault/useVaultSimulation";
import type { VaultGraph, VaultNode } from "@/types";
import { cn } from "@/lib/utils";

// --- Tiny text formatter for node content -----------------------------
//
// Ported from dashboard-vault-view.ts:formatContent. This is NOT a
// markdown library — it's 7 lines of escape + regex replacement. The
// vault content comes from local markdown files on the Mac Mini (not
// LLM-generated), and the transform operates on already-escaped
// text. Ported as-is to preserve visual parity with the previous
// vault's detail panel.
function formatVaultContent(text: string): { __html: string } {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  const html = escaped
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/^## (.+)$/gm, "<h3>$1</h3>")
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>)/gs, "<ul>$1</ul>")
    .replace(/<\/ul>\s*<ul>/g, "")
    .replace(/\n/g, "<br>");

  return { __html: html };
}

export function VaultView() {
  const query = useQuery({
    queryKey: queryKeys.vault,
    queryFn: fetchVaultGraph,
  });

  const colors = useMemo(() => new DomainColorMap(), []);
  const [selectedNode, setSelectedNode] = useState<VaultNode | null>(null);
  const [search, setSearch] = useState("");
  const [domainFilter, setDomainFilter] = useState<Set<string>>(new Set());

  // Initialize the domain filter to "everything on" when the graph
  // resolves. Effect (not useMemo) — calling setState during render
  // is a React anti-pattern that double-fires under StrictMode.
  useEffect(() => {
    if (!query.data) return;
    const set = new Set<string>();
    for (const n of query.data.nodes) {
      colors.get(n.domain);
      set.add(n.domain);
    }
    setDomainFilter(set);
  }, [query.data, colors]);

  const { svgRef, containerRef, handle } = useVaultSimulation({
    graph: query.data ?? null,
    onNodeClick: setSelectedNode,
    colors,
  });

  // Debounce search input into the simulation handle. The cleanup
  // effect cancels a pending timer on unmount so a stale debounce
  // can't fire against a torn-down handle.
  const searchTimer = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (searchTimer.current !== null) {
        window.clearTimeout(searchTimer.current);
        searchTimer.current = null;
      }
    };
  }, []);
  const onSearchChange = (value: string) => {
    setSearch(value);
    if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => {
      handle.current?.setSearch(value);
    }, 120);
  };

  // Compute next domain set OUTSIDE the setState updater so the
  // simulation side effect runs exactly once per click. State
  // updaters must be pure (Strict Mode may double-invoke).
  const toggleDomain = (domain: string) => {
    const next = new Set(domainFilter);
    if (next.has(domain)) next.delete(domain);
    else next.add(domain);
    setDomainFilter(next);
    handle.current?.setDomainFilter(next);
  };

  const callHandle = (fn: keyof VaultHandle) => () => {
    const h = handle.current;
    if (!h) return;
    if (fn === "zoomIn") h.zoomIn();
    else if (fn === "zoomOut") h.zoomOut();
    else if (fn === "reset") h.reset();
  };

  return (
    <div className="flex h-[calc(100dvh-3.5rem-env(safe-area-inset-bottom))] flex-col md:h-dvh">
      <header className="shrink-0 px-5 pt-6 md:px-8 md:pt-8">
        <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Knowledge Graph
        </div>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Family Vault</h1>
          <div className="flex items-center gap-2">
            <input
              type="search"
              placeholder="Search nodes…"
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="h-8 w-44 rounded-md border border-border bg-card px-2.5 text-sm outline-none focus:ring-2 focus:ring-ring md:w-56"
              data-testid="vault-search"
            />
            <div className="flex gap-1">
              <ZoomBtn label="+" title="Zoom in" onClick={callHandle("zoomIn")} />
              <ZoomBtn label="−" title="Zoom out" onClick={callHandle("zoomOut")} />
              <ZoomBtn label="⌂" title="Reset" onClick={callHandle("reset")} />
            </div>
          </div>
        </div>
        {query.data && (
          <div className="mt-1 text-xs text-muted-foreground">
            {query.data.nodes.length} nodes · {query.data.edges.length} connections
          </div>
        )}
        {query.data && query.data.nodes.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {colors.entries().map(([domain, c]) => {
              const on = domainFilter.has(domain);
              return (
                <button
                  key={domain}
                  type="button"
                  onClick={() => toggleDomain(domain)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-0.5 text-[0.6875rem] font-medium text-muted-foreground transition-opacity",
                    !on && "opacity-40",
                  )}
                >
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ background: c.raw }}
                  />
                  {domain}
                </button>
              );
            })}
          </div>
        )}
      </header>

      <div
        ref={containerRef}
        className="relative mx-5 mt-4 flex-1 overflow-hidden rounded-[var(--radius)] border border-border bg-card md:mx-8"
      >
        {query.isPending && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            Loading vault…
          </div>
        )}
        {query.isError && (
          <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
            <div>
              <div className="text-sm font-medium">Couldn't load the vault.</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {query.error instanceof ApiError
                  ? `${query.error.status} ${query.error.statusText}`
                  : String(query.error)}
              </div>
              <button
                onClick={() => query.refetch()}
                className="mt-3 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted"
              >
                Retry
              </button>
            </div>
          </div>
        )}
        {query.data && query.data.nodes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            Vault is empty.
          </div>
        )}
        <svg
          ref={svgRef}
          className="block h-full w-full"
          data-testid="vault-canvas"
          // Click on empty SVG background dismisses the detail panel.
          // The D3 node click handler calls event.stopPropagation()
          // (see useVaultSimulation.ts) so this only fires for true
          // background clicks. Restores parity with the previous
          // hand-rolled vault's svg.on('click', closePanel).
          onClick={() => setSelectedNode(null)}
        />

        {selectedNode && (
          <DetailPanel
            node={selectedNode}
            colors={colors}
            graph={query.data}
            onClose={() => setSelectedNode(null)}
            onSelectOther={(n) => setSelectedNode(n)}
          />
        )}
      </div>
    </div>
  );
}

function ZoomBtn({
  label,
  title,
  onClick,
}: {
  label: string;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="h-8 w-8 rounded-md border border-border bg-card text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      {label}
    </button>
  );
}

function DetailPanel({
  node,
  colors,
  graph,
  onClose,
  onSelectOther,
}: {
  node: VaultNode;
  colors: DomainColorMap;
  graph: VaultGraph | undefined;
  onClose: () => void;
  onSelectOther: (n: VaultNode) => void;
}) {
  const color = colors.get(node.domain);

  // graph here is the pre-simulation VaultGraph from React Query —
  // edges have plain string source/target, not d3-decorated SimNode
  // refs. The D3 simulation works with a separate copy inside
  // useVaultSimulation, so this view code never sees the decorated
  // shapes.
  const connected: VaultNode[] = [];
  if (graph) {
    for (const e of graph.edges) {
      if (e.source === node.id) {
        const t = graph.nodes.find((n) => n.id === e.target);
        if (t) connected.push(t);
      } else if (e.target === node.id) {
        const s = graph.nodes.find((n) => n.id === e.source);
        if (s) connected.push(s);
      }
    }
  }

  return (
    <aside
      data-testid="vault-detail"
      className={cn(
        "absolute bottom-0 left-0 right-0 z-10 max-h-[70%] overflow-y-auto border-t border-border bg-card p-5 shadow-lg",
        "md:bottom-auto md:left-auto md:right-0 md:top-0 md:h-full md:max-h-none md:w-[22rem] md:border-l md:border-t-0 md:shadow-none",
      )}
    >
      <button
        onClick={onClose}
        aria-label="Close"
        className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-md bg-muted text-muted-foreground hover:text-foreground"
      >
        ×
      </button>
      <div
        className="inline-block rounded-[0.25rem] px-2 py-0.5 text-[0.6875rem] font-semibold uppercase tracking-wider"
        style={{ background: color.raw + "1a", color: color.raw }}
      >
        {node.domain}
      </div>
      <h2 className="mt-2 text-xl font-semibold tracking-tight">{node.label}</h2>
      {node.description && (
        <p className="mt-1 text-sm text-muted-foreground">{node.description}</p>
      )}
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {node.durability && <span>{node.durability}</span>}
        {node.updated && <span>Updated {node.updated}</span>}
        {node.updated_by && <span>by {node.updated_by}</span>}
      </div>

      {connected.length > 0 && (
        <>
          <div className="mt-5 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
            Connected to
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {connected.map((c) => {
              const cc = colors.get(c.domain);
              return (
                <button
                  key={c.id}
                  onClick={() => onSelectOther(c)}
                  className="rounded-[0.25rem] border px-2 py-0.5 text-xs"
                  style={{ borderColor: cc.raw + "50", color: cc.raw }}
                >
                  {c.label}
                </button>
              );
            })}
          </div>
        </>
      )}

      {node.content && (
        <>
          <div className="mt-5 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
            Contents
          </div>
          <div
            className="vault-content mt-2 text-sm leading-relaxed text-muted-foreground"
            // Safe: vault content is local markdown from the Mac
            // Mini filesystem (not LLM-generated), escaped by
            // formatVaultContent before any tag substitution runs.
            // Not a markdown library — 7 lines of regex.
            dangerouslySetInnerHTML={formatVaultContent(node.content)}
          />
        </>
      )}
    </aside>
  );
}
